// The long-running agent: load config, start the local servers, hold the socket.
import { NO_ACCOUNT_MESSAGE, defaultConfigPath, loadConfig, resolveSecrets } from "./config";
import { Connection, type ConnectionOptions } from "./connection";
import { DeviceKey } from "./device-key";
import { Keychain } from "./keychain";
import { createLogger, errorClass, type Logger } from "./log";
import { ServerManager, type ServerManagerOptions } from "./servers";
import { StatusWriter, defaultStateDir, noAccountStatus, writeStatusFile, type StatusWriterOptions } from "./status";
import { AGENT_VERSION } from "./version";

/** Leaves room inside launchd's 20 s between SIGTERM and SIGKILL. */
const SHUTDOWN_DRAIN_MS = 10_000;

/** `run` was started on a Mac whose config names no account. */
export class NoAccountError extends Error {
  override name = "NoAccountError";
  constructor() {
    super(NO_ACCOUNT_MESSAGE);
  }
}

export interface DaemonDeps {
  keychain?: Keychain;
  log?: Logger;
  env?: NodeJS.ProcessEnv;
  /** Test overrides for reconnect and restart pacing. */
  timing?: ConnectionOptions["timing"];
  serverOptions?: ServerManagerOptions;
  statusOptions?: Partial<Pick<StatusWriterOptions, "minIntervalMs" | "refreshMs">>;
}

export interface Daemon {
  readonly connection: Connection;
  readonly servers: ServerManager;
  readonly status: StatusWriter;
  /** Re-checks for a pending rotation key. */
  announceRotation(): Promise<void>;
  /** Drains calls, closes the socket, stops the servers and removes the status file. */
  stop(drainMs?: number): Promise<void>;
}

/** Starts everything `run` runs, without touching process signals or exiting. */
export async function startDaemon(configPath: string = defaultConfigPath(), deps: DaemonDeps = {}): Promise<Daemon> {
  const log = deps.log ?? createLogger();
  const keychain = deps.keychain ?? new Keychain();
  const loaded = await loadConfig(configPath);
  const stateDir = defaultStateDir(deps.env ?? process.env);
  if (!loaded.account) {
    // Nothing is started. The file stays behind (with this process's pid) to tell the app why.
    await writeStatusFile(stateDir, noAccountStatus(loaded.machine)).catch((err: unknown) => {
      log.warn("status_write_failed", { errorClass: errorClass(err) });
    });
    throw new NoAccountError();
  }
  const { config, secrets } = await resolveSecrets(loaded, keychain);
  const deviceKey = new DeviceKey(keychain, config.machine, { account: loaded.account });
  const publicJwk = await deviceKey.publicJwk();
  if (!publicJwk) throw new Error("no device key in the Keychain; run `local-bridge-agent init` and register it");

  const enabled = Object.values(config.servers).filter((s) => s.enabled).length;
  log.info("starting", { version: AGENT_VERSION, machine: config.machine, account: loaded.account, kid: publicJwk.kid, servers: enabled, disabled: Object.keys(config.servers).length - enabled });
  const servers = new ServerManager(config.servers, { log, secrets, ...deps.serverOptions });
  const status = new StatusWriter({
    dir: stateDir,
    machine: config.machine,
    account: loaded.account,
    servers,
    log,
    ...deps.statusOptions,
  });
  // The file appears before the servers are up, so the app sees the agent as running at once.
  await status.start();
  await servers.start();

  const connection = new Connection({
    machine: config.machine,
    endpoint: config.endpoint,
    servers,
    signAssertion: () => deviceKey.signAssertion(),
    pendingRotation: () => deviceKey.pendingRotation(),
    onRotated: (kid) => deviceKey.promote(kid),
    onStatus: (s) => status.setConnection(s),
    onCallFinished: (c) => status.recordCall(c),
    log,
    ...(deps.timing ? { timing: deps.timing } : {}),
  });
  connection.start();

  return {
    connection,
    servers,
    status,
    announceRotation: () => connection.announceRotation(),
    async stop(drainMs: number = SHUTDOWN_DRAIN_MS) {
      try {
        await connection.stop(drainMs);
        await servers.stop();
      } finally {
        await status.stop();
      }
    },
  };
}

export async function runDaemon(configPath: string = defaultConfigPath(), deps: Pick<DaemonDeps, "keychain" | "env"> = {}): Promise<void> {
  const log = createLogger();
  const daemon = await startDaemon(configPath, { ...deps, log });

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("stopping", { signal });
    void (async () => {
      try {
        await daemon.stop(SHUTDOWN_DRAIN_MS);
      } catch (err) {
        log.error("shutdown_failed", { errorClass: errorClass(err) });
      }
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  // `rotate-key` stores a pending key; SIGHUP makes a running agent announce it now.
  process.on("SIGHUP", () => void daemon.announceRotation());
}

export function failStartup(err: unknown): never {
  // Startup errors are about config and keys, written by this program, so the message is safe to print.
  process.stderr.write(`local-bridge-agent: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
