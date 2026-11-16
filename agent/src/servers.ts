// Runs the configured local MCP servers and executes calls against them.
//
// Nothing in here may put tool arguments or result content into a log line or
// into an error message that goes to the cloud. Errors are reduced to a code,
// a fixed sentence and the error's class.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { ErrorCode, McpError, ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  ToolResultSchema,
  type CallErrorCode,
  type ResultMessage,
  type ServerInfo,
  type ServerStatus,
  type ToolInfo,
} from "../../infra/lib/shared/protocol";
import { accessFor, type ServerConfig } from "./config";
import { errorClass, silentLogger, type Logger } from "./log";
import { AGENT_VERSION } from "./version";

export const GLOBAL_CONCURRENCY = 4;

export interface ServerManagerOptions {
  log?: Logger;
  now?: () => number;
  /** Calls accepted at once across all servers, running or queued. */
  globalConcurrency?: number;
  restartMinMs?: number;
  restartMaxMs?: number;
  /** A server that stayed up this long gets its restart backoff reset. */
  stableAfterMs?: number;
  /** Time allowed for a server to start and list its tools. */
  startTimeoutMs?: number;
  /** Where a stdio server's stderr goes. Default "ignore": it can quote content. */
  stdioStderr?: "ignore" | "inherit";
  /** Resolved Keychain values, removed from any error text that is reported. */
  secrets?: string[];
}

export interface CallOptions {
  callId: string;
  /** Epoch milliseconds. */
  deadline: number;
  maxResultBytes: number;
  signal?: AbortSignal;
}

export interface ServerReport {
  name: string;
  status: "up" | "down";
  error?: string;
  exposed: ToolInfo[];
  /** Tools the server offers that the config does not expose. */
  unexposed: string[];
  /** Tools the config names that the server does not offer. */
  missing: string[];
}

/** The slice of the manager the connection needs; lets tests substitute a fake. */
export interface ToolRunner {
  list(): ServerInfo[];
  statuses(): ServerStatus[];
  onChange(listener: () => void): () => void;
  callTool(server: string, tool: string, args: Record<string, unknown>, opts: CallOptions): Promise<ResultMessage>;
}

interface Waiter {
  grant: () => void;
}
interface ServerState {
  name: string;
  config: ServerConfig;
  status: "up" | "down";
  error?: string;
  tools: ToolInfo[];
  offered: string[];
  client?: Client;
  generation: number;
  running: number;
  queue: Waiter[];
  attempt: number;
  upSince: number;
  restartTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Maps a local error to the macOS privacy permission that is missing, if that
 * is what it describes. The returned sentence is fixed text plus, at most, an
 * app name; it never carries the original message.
 */
export function permissionMessage(text: string): string | undefined {
  if (/-1743\b|not authori[sz]ed to send apple events/i.test(text)) {
    const app = /not authori[sz]ed to send apple events to ([A-Za-z0-9][A-Za-z0-9 ]{0,39})/i.exec(text)?.[1]?.trim();
    return `Automation permission not granted for ${app || "the target app"}`;
  }
  if (/authorization denied|unable to open database file/i.test(text)) {
    return "Full Disk Access not granted";
  }
  return undefined;
}

function textOf(content: Array<Record<string, unknown>>): string {
  let out = "";
  for (const block of content) {
    if (block.type === "text" && typeof block.text === "string") out += block.text.slice(0, 4000) + "\n";
    if (out.length > 16_000) break;
  }
  return out;
}

export class ServerManager implements ToolRunner {
  private readonly states = new Map<string, ServerState>();
  private readonly listeners = new Set<() => void>();
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly cap: number;
  private readonly restartMinMs: number;
  private readonly restartMaxMs: number;
  private readonly stableAfterMs: number;
  private readonly startTimeoutMs: number;
  private readonly stdioStderr: "ignore" | "inherit";
  private readonly secrets: string[];
  private inFlight = 0;
  private stopped = false;

  constructor(servers: Record<string, ServerConfig>, opts: ServerManagerOptions = {}) {
    this.log = opts.log ?? silentLogger;
    this.now = opts.now ?? Date.now;
    this.cap = opts.globalConcurrency ?? GLOBAL_CONCURRENCY;
    this.restartMinMs = opts.restartMinMs ?? 1_000;
    this.restartMaxMs = opts.restartMaxMs ?? 60_000;
    this.stableAfterMs = opts.stableAfterMs ?? 30_000;
    this.startTimeoutMs = opts.startTimeoutMs ?? 30_000;
    this.stdioStderr = opts.stdioStderr ?? "ignore";
    this.secrets = (opts.secrets ?? []).filter((s) => s.length >= 4);
    for (const [name, config] of Object.entries(servers)) {
      this.states.set(name, {
        name,
        config,
        status: "down",
        error: "starting",
        tools: [],
        offered: [],
        generation: 0,
        running: 0,
        queue: [],
        attempt: 0,
        upSince: 0,
      });
    }
  }

  /** Makes one start attempt for every server. A failure leaves that server down and retrying. */
  async start(): Promise<void> {
    await Promise.all([...this.states.values()].map((s) => this.connect(s)));
  }

  async stop(): Promise<void> {
    this.stopped = true;
    const closing: Promise<unknown>[] = [];
    for (const state of this.states.values()) {
      if (state.restartTimer) clearTimeout(state.restartTimer);
      state.generation++;
      const client = state.client;
      state.client = undefined;
      state.status = "down";
      state.error = "stopped";
      state.tools = [];
      if (client) closing.push(client.close().catch(() => {}));
    }
    await Promise.all(closing);
  }

  list(): ServerInfo[] {
    return [...this.states.values()].map((s) => ({
      name: s.name,
      status: s.status,
      ...(s.error && s.status === "down" ? { error: s.error } : {}),
      // A server that is down has its tools withheld.
      tools: s.status === "up" ? s.tools : [],
    }));
  }

  statuses(): ServerStatus[] {
    return this.list().map(({ name, status, error }) => ({ name, status, ...(error ? { error } : {}) }));
  }

  report(): ServerReport[] {
    return [...this.states.values()].map((s) => {
      const configured = [...new Set([...s.config.read, ...s.config.write])];
      return {
        name: s.name,
        status: s.status,
        ...(s.error && s.status === "down" ? { error: s.error } : {}),
        exposed: s.tools,
        unexposed: s.offered.filter((t) => !configured.includes(t)),
        missing: s.status === "up" ? configured.filter((t) => !s.offered.includes(t)) : [],
      };
    });
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emitChange(): void {
    for (const l of this.listeners) {
      try {
        l();
      } catch {
        // a listener must not take a server down
      }
    }
  }

  private scrub(text: string): string {
    let out = text;
    for (const secret of this.secrets) out = out.split(secret).join("[redacted]");
    return out.replace(/\s+/g, " ").slice(0, 300);
  }

  private createTransport(config: ServerConfig): Transport {
    if (config.transport === "stdio") {
      return new StdioClientTransport({
        command: config.command,
        args: config.args,
        // The SDK merges this over a short list of safe inherited variables.
        ...(config.env ? { env: config.env } : {}),
        ...(config.cwd ? { cwd: config.cwd } : {}),
        stderr: this.stdioStderr,
      });
    }
    const requestInit: RequestInit = config.headers ? { headers: config.headers } : {};
    return config.transport === "sse"
      ? new SSEClientTransport(new URL(config.url), { requestInit })
      : new StreamableHTTPClientTransport(new URL(config.url), { requestInit });
  }

  private async listTools(client: Client, config: ServerConfig): Promise<{ offered: string[]; tools: ToolInfo[] }> {
    const offered: string[] = [];
    const tools: ToolInfo[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < 50; page++) {
      const res = await client.listTools(cursor ? { cursor } : undefined, { timeout: this.startTimeoutMs });
      for (const tool of res.tools) {
        offered.push(tool.name);
        const access = accessFor(config, tool.name);
        if (!access) continue;
        tools.push({
          name: tool.name,
          ...(tool.description ? { description: tool.description.slice(0, 8192) } : {}),
          inputSchema: tool.inputSchema as Record<string, unknown>,
          access,
        });
      }
      cursor = res.nextCursor;
      if (!cursor) break;
    }
    return { offered, tools: tools.slice(0, 500) };
  }

  private async connect(state: ServerState): Promise<void> {
    if (this.stopped) return;
    const generation = ++state.generation;
    const client = new Client({ name: "local-bridge-agent", version: AGENT_VERSION }, { capabilities: {} });
    let closed = false;
    client.onclose = () => {
      closed = true;
      if (state.client === client) this.handleDown(state, generation, "server exited");
    };
    client.onerror = (err) => this.log.warn("server_error", { server: state.name, errorClass: errorClass(err) });
    try {
      await client.connect(this.createTransport(state.config), { timeout: this.startTimeoutMs });
      const { offered, tools } = await this.listTools(client, state.config);
      if (closed) throw new Error("server exited during startup");
      if (this.stopped || generation !== state.generation) {
        await client.close().catch(() => {});
        return;
      }
      client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
        void this.refreshTools(state, client);
      });
      state.client = client;
      state.status = "up";
      state.error = undefined;
      state.offered = offered;
      state.tools = tools;
      state.upSince = this.now();
      this.log.info("server_up", { server: state.name, tools: tools.length, offered: offered.length });
      this.emitChange();
    } catch (err) {
      await client.close().catch(() => {});
      if (this.stopped || generation !== state.generation) return;
      const reason = this.scrub(`failed to start: ${err instanceof Error ? err.message : String(err)}`);
      this.handleDown(state, generation, reason);
    }
  }

  private async refreshTools(state: ServerState, client: Client): Promise<void> {
    try {
      const { offered, tools } = await this.listTools(client, state.config);
      if (state.client !== client) return;
      const changed = JSON.stringify(tools) !== JSON.stringify(state.tools);
      state.offered = offered;
      state.tools = tools;
      if (changed) {
        this.log.info("server_tools_changed", { server: state.name, tools: tools.length });
        this.emitChange();
      }
    } catch (err) {
      this.log.warn("server_refresh_failed", { server: state.name, errorClass: errorClass(err) });
    }
  }

  private handleDown(state: ServerState, generation: number, reason: string): void {
    if (this.stopped || generation !== state.generation) return;
    const wasUp = state.status === "up";
    const client = state.client;
    state.client = undefined;
    if (client) void client.close().catch(() => {});
    if (wasUp && this.now() - state.upSince >= this.stableAfterMs) state.attempt = 0;
    const previousError = state.error;
    state.status = "down";
    state.error = reason;
    state.tools = [];
    const delay = Math.min(this.restartMaxMs, this.restartMinMs * 2 ** Math.min(state.attempt, 16));
    state.attempt++;
    this.log.warn("server_down", { server: state.name, restartInMs: delay, attempt: state.attempt });
    if (wasUp || previousError !== reason) this.emitChange();
    state.restartTimer = setTimeout(() => {
      state.restartTimer = undefined;
      void this.connect(state);
    }, delay);
  }

  private acquire(state: ServerState, signal: AbortSignal): Promise<void> {
    if (state.running < state.config.concurrency) {
      state.running++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const waiter: Waiter = {
        grant: () => {
          signal.removeEventListener("abort", onAbort);
          resolve();
        },
      };
      const onAbort = () => {
        const i = state.queue.indexOf(waiter);
        if (i >= 0) state.queue.splice(i, 1);
        reject(new Error("aborted while queued"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      state.queue.push(waiter);
    });
  }

  private release(state: ServerState): void {
    const next = state.queue.shift();
    if (next) next.grant();
    else state.running--;
  }

  async callTool(server: string, tool: string, args: Record<string, unknown>, opts: CallOptions): Promise<ResultMessage> {
    const started = this.now();
    const { callId } = opts;
    const done = (message: ResultMessage, extra: { resultBytes?: number; errorClass?: string } = {}): ResultMessage => {
      this.log.info("call", {
        callId,
        server,
        tool: tool.slice(0, 128),
        ms: this.now() - started,
        outcome: message.ok ? "ok" : message.error.code,
        ...extra,
      });
      return message;
    };
    const fail = (code: CallErrorCode, message: string, cls?: string): ResultMessage =>
      done({ type: "result", callId, ok: false, error: { code, message } }, cls ? { errorClass: cls } : {});

    const state = this.states.get(server);
    const access = state && accessFor(state.config, tool);
    if (!state || !access) return fail("not_exposed", "this server or tool is not exposed by the machine's config");
    if (state.status !== "up" || !state.client) {
      return fail("server_down", `local server "${server}" is down${state.error ? `: ${state.error}` : ""}`.slice(0, 1000));
    }
    if (!state.tools.some((t) => t.name === tool)) {
      return fail("not_exposed", "the machine's config names this tool but the local server does not offer it");
    }
    const callLimit = state.config.callTimeoutMs ? started + state.config.callTimeoutMs : Infinity;
    const deadline = Math.min(opts.deadline, callLimit);
    const budget = deadline - started;
    if (budget <= 0) return fail("timeout", "the deadline had already passed when the call was started");
    if (this.inFlight >= this.cap) return fail("busy", `too many calls in flight on this machine (limit ${this.cap})`);

    this.inFlight++;
    const abort = new AbortController();
    let stop: "timeout" | "cancelled" | undefined;
    const timer = setTimeout(() => {
      stop ??= "timeout";
      abort.abort();
    }, Math.min(budget, 2_000_000_000));
    const onCancel = () => {
      stop ??= "cancelled";
      abort.abort();
    };
    if (opts.signal?.aborted) onCancel();
    else opts.signal?.addEventListener("abort", onCancel, { once: true });

    try {
      await this.acquire(state, abort.signal);
      let raw: unknown;
      try {
        if (abort.signal.aborted) throw new Error("aborted");
        const client = state.client;
        if (!client) return fail("server_down", `local server "${server}" went down before the call started`);
        raw = await client.callTool({ name: tool, arguments: args }, undefined, {
          signal: abort.signal,
          // Our own timer decides; this is only a backstop inside the SDK.
          timeout: Math.min(budget, 2_000_000_000) + 5_000,
        });
      } finally {
        this.release(state);
      }
      const parsed = ToolResultSchema.safeParse(raw);
      if (!parsed.success) return fail("tool_error", "the local server returned a malformed result", "MalformedResult");
      const result = parsed.data;
      const resultBytes = Buffer.byteLength(JSON.stringify(result), "utf8");
      if (resultBytes > opts.maxResultBytes) {
        return done(
          {
            type: "result",
            callId,
            ok: false,
            error: { code: "too_large", message: `result too large (${resultBytes} bytes, limit ${opts.maxResultBytes})` },
          },
          { resultBytes },
        );
      }
      if (result.isError) {
        const permission = permissionMessage(textOf(result.content));
        if (permission) return fail("permission", permission);
      }
      return done({ type: "result", callId, ok: true, result }, { resultBytes });
    } catch (err) {
      const cls = errorClass(err);
      if (stop === "timeout") {
        const seconds = Math.max(1, Math.round(budget / 1000));
        const note = access === "write" ? "; the write may still have happened" : "";
        return fail("timeout", `timed out after ${seconds} s${note}`);
      }
      if (stop === "cancelled") return fail("cancelled", "the call was cancelled");
      const permission = permissionMessage(err instanceof Error ? err.message : String(err));
      if (permission) return fail("permission", permission, cls);
      if (err instanceof McpError && err.code === ErrorCode.ConnectionClosed) {
        return fail("server_down", `local server "${server}" exited during the call`, cls);
      }
      if (err instanceof McpError && err.code === ErrorCode.RequestTimeout) {
        return fail("timeout", "the local server did not answer in time", cls);
      }
      // The original message can quote arguments or content, so it is dropped.
      return fail("tool_error", `the local server reported an error (${cls})`, cls);
    } finally {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onCancel);
      this.inFlight--;
    }
  }
}
