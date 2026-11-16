// The machine's one outbound WebSocket to the cloud (spec sections 6, 10, 11).
//
// Rules this file keeps:
//  - every machine->cloud message goes through encodeFrames, one ws message per frame;
//  - a call is answered on the socket it arrived on or not at all: nothing is
//    queued across a reconnect, in either direction;
//  - a call whose deadline has passed is refused, never run.
import { randomBytes } from "node:crypto";
import WebSocket from "ws";
import {
  CallSchema,
  CloudMessageSchema,
  DEADLINE_SKEW_MS,
  HEARTBEAT_INTERVAL_MS,
  PROTOCOL_VERSION,
  encodeFrames,
  type CallMessage,
  type MachineMessage,
  type ResultMessage,
} from "../../infra/lib/shared/protocol";
import { errorClass, silentLogger, type Logger } from "./log";
import type { PublicDeviceJwk } from "./device-key";
import type { ToolRunner } from "./servers";
import { AGENT_VERSION } from "./version";

/** The part of a `ws` WebSocket the connection uses. */
export interface SocketLike {
  readonly readyState: number;
  send(data: string, cb?: (err?: Error | null) => void): void;
  close(code?: number, reason?: string): void;
  terminate?(): void;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "close", listener: (code: number) => void): unknown;
  on(event: "error", listener: (err: Error) => void): unknown;
}
export type SocketFactory = (url: string, options: { headers: Record<string, string> }) => SocketLike;

type TimerHandle = unknown;
export interface Timers {
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
  setInterval(fn: () => void, ms: number): TimerHandle;
  clearInterval(handle: TimerHandle): void;
}

export interface ConnectionTiming {
  heartbeatMs: number;
  /** API Gateway closes a connection at 2 h; leave on our own terms before that. */
  plannedReconnectMs: number;
  /** How long a planned reconnect or shutdown waits for in-flight calls. */
  drainMs: number;
  backoffMinMs: number;
  backoffMaxMs: number;
  wakeCheckMs: number;
  /** A wake-check tick this late means the machine slept. */
  wakeThresholdMs: number;
  helloDebounceMs: number;
  handshakeTimeoutMs: number;
}

export const DEFAULT_TIMING: ConnectionTiming = {
  heartbeatMs: HEARTBEAT_INTERVAL_MS,
  plannedReconnectMs: 110 * 60_000,
  drainMs: 25_000,
  backoffMinMs: 1_000,
  backoffMaxMs: 60_000,
  wakeCheckMs: 5_000,
  wakeThresholdMs: 20_000,
  helloDebounceMs: 250,
  handshakeTimeoutMs: 15_000,
};

export interface ConnectionOptions {
  machine: string;
  endpoint: string;
  servers: ToolRunner;
  /** A fresh device assertion for each connection attempt. */
  signAssertion: () => Promise<string>;
  /** A pending rotation key to announce after hello, if there is one. */
  pendingRotation?: () => Promise<PublicDeviceJwk | null>;
  /** The cloud accepted the rotation key `kid`. Resolve true once it is the current key. */
  onRotated?: (kid: string) => Promise<boolean>;
  log?: Logger;
  now?: () => number;
  random?: () => number;
  timers?: Timers;
  createSocket?: SocketFactory;
  timing?: Partial<ConnectionTiming>;
  agentVersion?: string;
}

const OPEN = 1;

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

function rawToString(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (Array.isArray(data)) return Buffer.concat(data as Buffer[]).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return "";
}

export class Connection {
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly timers: Timers;
  private readonly createSocket: SocketFactory;
  private readonly timing: ConnectionTiming;

  private socket: SocketLike | undefined;
  /** Bumped for every socket; lets late events from an old socket be ignored. */
  private epoch = 0;
  private open = false;
  private draining = false;
  private stopped = true;
  private attempt = 0;
  private lastTick = 0;

  private retryTimer: TimerHandle;
  private heartbeatTimer: TimerHandle;
  private plannedTimer: TimerHandle;
  private wakeTimer: TimerHandle;
  private helloTimer: TimerHandle;
  private unsubscribe: (() => void) | undefined;

  /** Calls running for the current socket. */
  private readonly inFlight = new Map<string, AbortController>();
  private drainWaiters: Array<() => void> = [];

  constructor(private readonly opts: ConnectionOptions) {
    this.log = opts.log ?? silentLogger;
    this.now = opts.now ?? Date.now;
    this.random = opts.random ?? Math.random;
    this.timers = opts.timers ?? realTimers;
    this.timing = { ...DEFAULT_TIMING, ...opts.timing };
    this.createSocket =
      opts.createSocket ??
      ((url, o) =>
        new WebSocket(url, {
          headers: o.headers,
          handshakeTimeout: this.timing.handshakeTimeoutMs,
          maxPayload: 256 * 1024,
        }) as unknown as SocketLike);
  }

  get connected(): boolean {
    return this.open;
  }

  start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.lastTick = this.now();
    this.wakeTimer = this.timers.setInterval(() => this.wakeCheck(), this.timing.wakeCheckMs);
    this.unsubscribe = this.opts.servers.onChange(() => this.scheduleHello());
    void this.connect();
  }

  /** Lets in-flight calls finish (up to `drainMs`), then closes for good. */
  async stop(drainMs: number = this.timing.drainMs): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    this.timers.clearInterval(this.wakeTimer);
    this.timers.clearTimeout(this.retryTimer);
    this.draining = true;
    await this.drain(drainMs);
    this.dropSocket(1000);
  }

  /** Re-checks for a pending rotation key (the CLI's `rotate-key` asks for this with SIGHUP). */
  async announceRotation(): Promise<void> {
    if (!this.open || !this.opts.pendingRotation) return;
    try {
      const jwk = await this.opts.pendingRotation();
      if (!jwk || !this.open) return;
      this.send({ type: "rotate", kid: jwk.kid, jwk: { kty: jwk.kty, crv: jwk.crv, x: jwk.x } });
      this.log.info("rotate_announced", { kid: jwk.kid });
    } catch (err) {
      this.log.warn("rotate_announce_failed", { errorClass: errorClass(err) });
    }
  }

  // -------------------------------------------------------------------------
  // Connecting
  // -------------------------------------------------------------------------

  private async connect(): Promise<void> {
    if (this.stopped) return;
    const epoch = ++this.epoch;
    this.draining = false;
    let assertion: string;
    try {
      assertion = await this.opts.signAssertion();
    } catch (err) {
      this.log.error("assertion_failed", { errorClass: errorClass(err) });
      if (epoch === this.epoch) this.scheduleRetry();
      return;
    }
    if (this.stopped || epoch !== this.epoch) return;

    let socket: SocketLike;
    try {
      socket = this.createSocket(this.opts.endpoint, { headers: { Authorization: `Bearer ${assertion}` } });
    } catch (err) {
      this.log.error("socket_create_failed", { errorClass: errorClass(err) });
      this.scheduleRetry();
      return;
    }
    this.socket = socket;
    socket.on("open", () => {
      if (epoch === this.epoch) this.onOpen();
    });
    socket.on("message", (data) => {
      if (epoch === this.epoch) this.onMessage(rawToString(data), epoch);
    });
    socket.on("error", (err) => {
      // `ws` reports a refused upgrade (401/403 from the authorizer) here, then closes.
      if (epoch === this.epoch) this.log.warn("socket_error", { errorClass: errorClass(err) });
    });
    socket.on("close", (code) => {
      if (epoch === this.epoch) this.onClose(code);
    });
  }

  private onOpen(): void {
    this.open = true;
    this.attempt = 0;
    this.log.info("connected", { endpoint: this.opts.endpoint });
    this.sendHello();
    this.heartbeatTimer = this.timers.setInterval(() => {
      this.send({ type: "hb", servers: this.opts.servers.statuses() });
    }, this.timing.heartbeatMs);
    this.plannedTimer = this.timers.setTimeout(() => void this.plannedReconnect(), this.timing.plannedReconnectMs);
    void this.announceRotation();
  }

  /** The socket closed without us asking for it. */
  private onClose(code: number): void {
    const wasOpen = this.open;
    this.teardown();
    this.log.warn("disconnected", { code, wasOpen });
    this.scheduleRetry();
  }

  /** Clears everything tied to the current socket and abandons its calls. */
  private teardown(): void {
    this.open = false;
    this.socket = undefined;
    this.epoch++;
    this.timers.clearInterval(this.heartbeatTimer);
    this.timers.clearTimeout(this.plannedTimer);
    this.timers.clearTimeout(this.helloTimer);
    this.helloTimer = undefined;
    // Their results can no longer be delivered, and they are never carried over.
    for (const controller of this.inFlight.values()) controller.abort();
    this.inFlight.clear();
    this.releaseDrainWaiters();
  }

  private dropSocket(code?: number): void {
    const socket = this.socket;
    this.teardown();
    if (!socket) return;
    try {
      if (code !== undefined && socket.readyState === OPEN) socket.close(code);
      else if (socket.terminate) socket.terminate();
      else socket.close();
    } catch {
      // already gone
    }
  }

  private scheduleRetry(): void {
    if (this.stopped) return;
    const ceiling = Math.min(this.timing.backoffMaxMs, this.timing.backoffMinMs * 2 ** Math.min(this.attempt, 16));
    // Half fixed, half random, so the first retry is 0.5-1 s and the cap 30-60 s.
    const delay = Math.round(ceiling * (0.5 + this.random() * 0.5));
    this.attempt++;
    this.log.info("reconnect_scheduled", { inMs: delay, attempt: this.attempt });
    this.timers.clearTimeout(this.retryTimer);
    this.retryTimer = this.timers.setTimeout(() => void this.connect(), delay);
  }

  /** Closes the current socket, if any, and connects again right now. */
  private reconnectNow(reason: string): void {
    if (this.stopped) return;
    this.log.info("reconnect_now", { reason });
    this.timers.clearTimeout(this.retryTimer);
    this.dropSocket(reason === "wake" ? undefined : 1000);
    this.attempt = 0;
    void this.connect();
  }

  private async plannedReconnect(): Promise<void> {
    if (this.stopped || !this.open) return;
    const epoch = this.epoch;
    this.draining = true;
    this.log.info("planned_reconnect", { inFlight: this.inFlight.size });
    await this.drain(this.timing.drainMs);
    if (this.stopped || epoch !== this.epoch) return;
    this.reconnectNow("planned");
  }

  private drain(maxMs: number): Promise<void> {
    if (this.inFlight.size === 0 || maxMs <= 0) return Promise.resolve();
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        this.timers.clearTimeout(timer);
        resolve();
      };
      const timer = this.timers.setTimeout(finish, maxMs);
      this.drainWaiters.push(finish);
    });
  }

  private releaseDrainWaiters(): void {
    const waiters = this.drainWaiters;
    this.drainWaiters = [];
    for (const w of waiters) w();
  }

  private wakeCheck(): void {
    const now = this.now();
    const elapsed = now - this.lastTick;
    this.lastTick = now;
    if (elapsed > this.timing.wakeThresholdMs) {
      // The process was suspended: the socket is very likely dead and the
      // cloud has already marked the machine offline.
      this.reconnectNow("wake");
    }
  }

  // -------------------------------------------------------------------------
  // Sending
  // -------------------------------------------------------------------------

  private send(message: MachineMessage, socket: SocketLike | undefined = this.socket): boolean {
    if (!socket || socket !== this.socket || !this.open || socket.readyState !== OPEN) return false;
    const frames = encodeFrames(message, randomBytes(16).toString("hex"));
    for (const frame of frames) {
      socket.send(JSON.stringify(frame), (err) => {
        if (err) this.log.warn("send_failed", { type: message.type, errorClass: errorClass(err) });
      });
    }
    return true;
  }

  private sendHello(): void {
    try {
      this.send({
        type: "hello",
        protocol: PROTOCOL_VERSION,
        machine: this.opts.machine,
        agentVersion: this.opts.agentVersion ?? AGENT_VERSION,
        servers: this.opts.servers.list(),
      });
    } catch (err) {
      this.log.error("hello_failed", { errorClass: errorClass(err) });
    }
  }

  /** A server went up or down, or its tool list changed. */
  private scheduleHello(): void {
    if (!this.open || this.helloTimer !== undefined) return;
    this.helloTimer = this.timers.setTimeout(() => {
      this.helloTimer = undefined;
      if (this.open) this.sendHello();
    }, this.timing.helloDebounceMs);
  }

  private sendResult(result: ResultMessage, socket: SocketLike): void {
    try {
      if (!this.send(result, socket)) this.log.warn("result_dropped", { callId: result.callId, reason: "socket_gone" });
    } catch {
      // encodeFrames refuses a message above its frame budget.
      this.send(
        {
          type: "result",
          callId: result.callId,
          ok: false,
          error: { code: "too_large", message: "result too large to send over the bridge" },
        },
        socket,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Receiving
  // -------------------------------------------------------------------------

  private onMessage(text: string, epoch: number): void {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      this.log.warn("bad_message", { reason: "not_json", bytes: text.length });
      return;
    }
    const type = (json as { type?: unknown } | null)?.type;
    if (type === "call") {
      const call = CallSchema.safeParse(json);
      if (!call.success) {
        this.log.warn("bad_message", { reason: "invalid_call", bytes: text.length });
        return;
      }
      void this.onCall(call.data, text.length);
      return;
    }
    const parsed = CloudMessageSchema.safeParse(json);
    if (!parsed.success) {
      this.log.warn("bad_message", { reason: "unknown_or_invalid", bytes: text.length });
      return;
    }
    const message = parsed.data;
    switch (message.type) {
      case "welcome":
        this.log.info("welcome", { clockSkewMs: Math.round(message.serverTime - this.now()) });
        return;
      case "cancel": {
        const controller = this.inFlight.get(message.callId);
        this.log.info("cancel", { callId: message.callId, known: controller !== undefined });
        controller?.abort();
        return;
      }
      case "rotated":
        void this.onRotated(message.kid, epoch);
        return;
      default:
        return;
    }
  }

  private async onRotated(kid: string, epoch: number): Promise<void> {
    if (!this.opts.onRotated) return;
    try {
      const promoted = await this.opts.onRotated(kid);
      this.log.info("rotated", { kid: kid.slice(0, 64), promoted });
      // Authenticate with the new key now; that is what makes the cloud drop the old one.
      if (promoted && epoch === this.epoch) await this.plannedReconnect();
    } catch (err) {
      this.log.error("rotate_promote_failed", { errorClass: errorClass(err) });
    }
  }

  private async onCall(call: CallMessage, argBytes: number): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    const { callId } = call;
    if (this.inFlight.has(callId)) {
      this.log.warn("duplicate_call", { callId });
      return;
    }
    // Receipt is acknowledged first, whatever happens next: the cloud reads a
    // missing ack as "machine asleep".
    this.send({ type: "ack", callId }, socket);

    const refuse = (code: "expired" | "busy", message: string) => {
      this.log.info("call_refused", { callId, server: call.server, tool: call.tool, code });
      this.sendResult({ type: "result", callId, ok: false, error: { code, message } }, socket);
    };
    const now = this.now();
    if (call.deadline + DEADLINE_SKEW_MS < now) {
      return refuse("expired", "the call's deadline had passed when it reached the machine");
    }
    if (this.draining) return refuse("busy", "the machine is reconnecting, retry in a few seconds");

    const controller = new AbortController();
    this.inFlight.set(callId, controller);
    this.log.info("call_start", { callId, server: call.server, tool: call.tool, argBytes });
    let result: ResultMessage;
    try {
      result = await this.opts.servers.callTool(call.server, call.tool, call.arguments, {
        callId,
        // A deadline inside the skew allowance still gets a moment to run.
        deadline: Math.max(call.deadline, now + 1_000),
        maxResultBytes: call.maxResultBytes,
        signal: controller.signal,
      });
    } catch (err) {
      this.log.error("call_crashed", { callId, errorClass: errorClass(err) });
      result = {
        type: "result",
        callId,
        ok: false,
        error: { code: "tool_error", message: `the agent failed to run the call (${errorClass(err)})` },
      };
    }
    if (this.inFlight.get(callId) === controller) {
      this.inFlight.delete(callId);
      this.sendResult(result, socket);
      if (this.inFlight.size === 0) this.releaseDrainWaiters();
    }
    // Otherwise the socket this call came in on is gone, and so is its result.
  }
}
