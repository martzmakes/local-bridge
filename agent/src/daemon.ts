// The long-running agent: load config, start the local servers, hold the socket.
import { defaultConfigPath, loadConfig, resolveSecrets } from "./config";
import { Connection } from "./connection";
import { DeviceKey } from "./device-key";
import { Keychain } from "./keychain";
import { createLogger, errorClass } from "./log";
import { ServerManager } from "./servers";
import { AGENT_VERSION } from "./version";

/** Leaves room inside launchd's 20 s between SIGTERM and SIGKILL. */
const SHUTDOWN_DRAIN_MS = 10_000;

export async function runDaemon(configPath: string = defaultConfigPath()): Promise<void> {
  const log = createLogger();
  const keychain = new Keychain();
  const { config, secrets } = await resolveSecrets(await loadConfig(configPath), keychain);
  const deviceKey = new DeviceKey(keychain, config.machine);
  const publicJwk = await deviceKey.publicJwk();
  if (!publicJwk) throw new Error("no device key in the Keychain; run `local-bridge-agent init` and register it");

  log.info("starting", { version: AGENT_VERSION, machine: config.machine, kid: publicJwk.kid, servers: Object.keys(config.servers).length });
  const servers = new ServerManager(config.servers, { log, secrets });
  await servers.start();

  const connection = new Connection({
    machine: config.machine,
    endpoint: config.endpoint,
    servers,
    signAssertion: () => deviceKey.signAssertion(),
    pendingRotation: () => deviceKey.pendingRotation(),
    onRotated: (kid) => deviceKey.promote(kid),
    log,
  });
  connection.start();

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    log.info("stopping", { signal });
    void (async () => {
      try {
        await connection.stop(SHUTDOWN_DRAIN_MS);
        await servers.stop();
      } catch (err) {
        log.error("shutdown_failed", { errorClass: errorClass(err) });
      }
      process.exit(0);
    })();
  };
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGINT", () => shutdown("SIGINT"));
  // `rotate-key` stores a pending key; SIGHUP makes a running agent announce it now.
  process.on("SIGHUP", () => void connection.announceRotation());
}

export function failStartup(err: unknown): never {
  // Startup errors are about config and keys, written by this program, so the message is safe to print.
  process.stderr.write(`local-bridge-agent: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
