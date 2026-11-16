// The status file the macOS app reads (mac-app spec section 5).
//
// One small JSON document, rewritten atomically on every state change and at
// least every 15 s. It holds names, states and counts only: never a tool's
// arguments or results.
import { chmod, mkdir, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Access, CallErrorCode } from "../../infra/lib/shared/protocol";
import type { CallFinished, ConnectionStatus } from "./connection";
import { errorClass, silentLogger, type Logger } from "./log";
import type { ToolRunner } from "./servers";
import { AGENT_VERSION } from "./version";

export const STATUS_FILE_NAME = "status.json";

export interface StatusDocument {
  pid: number;
  version: string;
  machine: string;
  /** The account id from the config, or null when this Mac is not signed in. */
  account: string | null;
  /** Epoch milliseconds of this write. A reader treats a file older than 45 s as "not running". */
  updatedAt: number;
  connection: ConnectionStatus;
  /** Enabled servers only; a disabled server is not started and not listed. */
  servers: Array<{
    name: string;
    title: string | null;
    status: "up" | "down";
    error: string | null;
    tools: Array<{ name: string; access: Access }>;
  }>;
  calls: {
    total: number;
    failed: number;
    lastAt: number | null;
    /** `<server>.<tool>` */
    lastTool: string | null;
    lastOutcome: "ok" | CallErrorCode | null;
  };
}

export function defaultStateDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOCAL_BRIDGE_STATE_DIR || join(homedir(), "Library", "Application Support", "local-bridge");
}

/**
 * Writes `status.json` in `dir` atomically (temp file, then rename), mode 0600.
 * `proceed` is asked just before the rename; false abandons the write.
 */
export async function writeStatusFile(dir: string, doc: StatusDocument, proceed: () => boolean = () => true): Promise<boolean> {
  const path = join(dir, STATUS_FILE_NAME);
  const tmpPath = `${path}.${doc.pid}.tmp`;
  await mkdir(dir, { recursive: true, mode: 0o700 });
  await writeFile(tmpPath, JSON.stringify(doc) + "\n", { mode: 0o600 });
  // The mode argument only applies when the file is created.
  await chmod(tmpPath, 0o600);
  if (!proceed()) {
    await rm(tmpPath, { force: true });
    return false;
  }
  await rename(tmpPath, path);
  return true;
}

/** The file `run` leaves behind when it refuses to start for lack of an account, so the app can say why. */
export function noAccountStatus(machine: string, now: number = Date.now(), pid: number = process.pid): StatusDocument {
  return {
    pid,
    version: AGENT_VERSION,
    machine,
    account: null,
    updatedAt: now,
    connection: { state: "offline", since: now, lastError: "no_account" },
    servers: [],
    calls: { total: 0, failed: 0, lastAt: null, lastTool: null, lastOutcome: null },
  };
}

export interface StatusWriterOptions {
  dir: string;
  machine: string;
  account?: string | null;
  servers: Pick<ToolRunner, "list" | "onChange">;
  version?: string;
  pid?: number;
  now?: () => number;
  log?: Logger;
  /** Least time between two writes; a burst of changes collapses into one write per interval. */
  minIntervalMs?: number;
  /** The file is rewritten at least this often even when nothing changed. */
  refreshMs?: number;
}

export class StatusWriter {
  readonly path: string;
  private readonly tmpPath: string;
  private readonly now: () => number;
  private readonly log: Logger;
  private readonly minIntervalMs: number;
  private readonly refreshMs: number;

  private connection: ConnectionStatus;
  private readonly calls: StatusDocument["calls"] = { total: 0, failed: 0, lastAt: null, lastTool: null, lastOutcome: null };

  private started = false;
  private stopped = false;
  private lastWriteAt = -Infinity;
  private dirty = false;
  private debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private refreshTimer: ReturnType<typeof setInterval> | undefined;
  private writing: Promise<void> | undefined;
  private unsubscribe: (() => void) | undefined;
  /** Counts completed writes; lets tests see the debounce. */
  writes = 0;

  constructor(private readonly opts: StatusWriterOptions) {
    this.path = join(opts.dir, STATUS_FILE_NAME);
    this.tmpPath = `${this.path}.${opts.pid ?? process.pid}.tmp`;
    this.now = opts.now ?? Date.now;
    this.log = opts.log ?? silentLogger;
    this.minIntervalMs = opts.minIntervalMs ?? 250;
    this.refreshMs = opts.refreshMs ?? 15_000;
    this.connection = { state: "connecting", since: this.now(), lastError: null };
  }

  /** Writes the file once and keeps it fresh from then on. */
  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    this.unsubscribe = this.opts.servers.onChange(() => this.touch());
    this.refreshTimer = setInterval(() => this.touch(), this.refreshMs);
    this.refreshTimer.unref();
    this.touch();
    await this.writing;
  }

  setConnection(status: ConnectionStatus): void {
    this.connection = { state: status.state, since: status.since, lastError: status.lastError };
    this.touch();
  }

  recordCall(call: CallFinished): void {
    this.calls.total++;
    if (call.outcome !== "ok") this.calls.failed++;
    this.calls.lastAt = call.at;
    this.calls.lastTool = `${call.server}.${call.tool}`;
    this.calls.lastOutcome = call.outcome;
    this.touch();
  }

  snapshot(): StatusDocument {
    return {
      pid: this.opts.pid ?? process.pid,
      version: this.opts.version ?? AGENT_VERSION,
      machine: this.opts.machine,
      account: this.opts.account ?? null,
      updatedAt: this.now(),
      connection: { ...this.connection },
      servers: this.opts.servers.list().map((s) => ({
        name: s.name,
        title: s.title ?? null,
        status: s.status,
        error: s.error ?? null,
        tools: s.tools.map((t) => ({ name: t.name, access: t.access })),
      })),
      calls: { ...this.calls },
    };
  }

  /** Something changed: write now, or as soon as the rate limit allows. */
  touch(): void {
    if (!this.started || this.stopped) return;
    this.dirty = true;
    if (this.writing || this.debounceTimer) return;
    const wait = this.lastWriteAt + this.minIntervalMs - Date.now();
    if (wait <= 0) {
      this.flush();
      return;
    }
    this.debounceTimer = setTimeout(() => {
      this.debounceTimer = undefined;
      this.flush();
    }, wait);
  }

  private flush(): void {
    if (this.stopped || this.writing || !this.dirty) return;
    this.dirty = false;
    this.lastWriteAt = Date.now();
    this.writing = this.writeOnce().finally(() => {
      this.writing = undefined;
      // Changes that arrived during the write go out after the usual interval.
      if (this.dirty) this.touch();
    });
  }

  private async writeOnce(): Promise<void> {
    try {
      const written = await writeStatusFile(this.opts.dir, this.snapshot(), () => !this.stopped);
      if (written) this.writes++;
    } catch (err) {
      this.log.warn("status_write_failed", { errorClass: errorClass(err) });
    }
  }

  /** Stops writing and removes the file. */
  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.unsubscribe?.();
    if (this.debounceTimer) clearTimeout(this.debounceTimer);
    if (this.refreshTimer) clearInterval(this.refreshTimer);
    await this.writing;
    await rm(this.path, { force: true }).catch(() => {});
    await rm(this.tmpPath, { force: true }).catch(() => {});
  }
}
