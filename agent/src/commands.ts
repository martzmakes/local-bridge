// CLI commands: init, pubkey, rotate-key, doctor, run.
import { ConfigError, defaultConfigPath, loadConfig, resolveSecrets, type Config } from "./config";
import { runDaemon } from "./daemon";
import { DeviceKey, type PublicDeviceJwk } from "./device-key";
import { Keychain } from "./keychain";
import { formatTable, kindOf, permissionRows } from "./permissions";
import { ServerManager } from "./servers";
import { NAME_RE } from "../../infra/lib/shared/protocol";
import { AGENT_VERSION } from "./version";

export const LAUNCHD_LABEL = "com.martzmakes.local-bridge";

export interface CliDeps {
  out?: (line: string) => void;
  keychain?: Keychain;
  env?: NodeJS.ProcessEnv;
}

const USAGE = `local-bridge-agent ${AGENT_VERSION}

Usage: local-bridge-agent <command> [--config <path>] [--machine <name>] [--verbose]

  init         Generate and store the device key if there is none; print the public JWK
  pubkey       Print the public JWK of the device key
  rotate-key   Generate a pending key; the running agent announces it to the cloud
  doctor       Check config, key, each local server and the permissions they need
  run          Run the agent in the foreground (what the LaunchAgent does)

--machine is only needed by init and pubkey before a config file exists.`;

interface Args {
  command: string | undefined;
  config?: string;
  machine?: string;
  verbose: boolean;
}

function parseArgs(argv: string[]): Args {
  const args: Args = { command: undefined, verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--config" || a === "--machine") {
      const value = argv[++i];
      if (!value) throw new Error(`${a} needs a value`);
      if (a === "--config") args.config = value;
      else args.machine = value;
    } else if (a === "--verbose") args.verbose = true;
    else if (a === "--help" || a === "-h") args.command = "help";
    else if (!a.startsWith("-") && args.command === undefined) args.command = a;
    else throw new Error(`unexpected argument: ${a}`);
  }
  return args;
}

async function machineName(args: Args, configPath: string): Promise<string> {
  if (args.machine) {
    if (!NAME_RE.test(args.machine)) throw new Error("--machine must match [a-z0-9]{1,16}");
    return args.machine;
  }
  try {
    return (await loadConfig(configPath)).machine;
  } catch (err) {
    if (err instanceof ConfigError) throw new Error(`${err.message}\n(pass --machine <name> to work without a config file)`);
    throw err;
  }
}

function publicJson(jwk: PublicDeviceJwk): string {
  return JSON.stringify({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, kid: jwk.kid });
}

function registerLine(machine: string, jwk: PublicDeviceJwk): string {
  return `npx ts-node scripts/admin.ts device register ${machine} '${publicJson(jwk)}'`;
}

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number | undefined> {
  const out = deps.out ?? ((line: string) => process.stdout.write(line + "\n"));
  const keychain = deps.keychain ?? new Keychain();
  const args = parseArgs(argv);
  const configPath = args.config ?? defaultConfigPath(deps.env ?? process.env);

  switch (args.command) {
    case "init": {
      const machine = await machineName(args, configPath);
      const { jwk, created } = await new DeviceKey(keychain, machine).ensure();
      out(created ? `Generated a device key for "${machine}" and stored it in the login Keychain.` : `A device key for "${machine}" already exists; nothing was changed.`);
      out("");
      out("Public key (JWK):");
      out(publicJson(jwk));
      out("");
      out("Register it from the infra/ directory on the admin machine:");
      out(registerLine(machine, jwk));
      return 0;
    }
    case "pubkey": {
      const machine = await machineName(args, configPath);
      const key = new DeviceKey(keychain, machine);
      const jwk = await key.publicJwk();
      if (!jwk) {
        out(`No device key for "${machine}". Run: local-bridge-agent init`);
        return 1;
      }
      out(publicJson(jwk));
      const pending = await key.pendingPublicJwk();
      if (pending && pending.kid !== jwk.kid) out(`pending rotation key: ${publicJson(pending)}`);
      return 0;
    }
    case "rotate-key": {
      const machine = await machineName(args, configPath);
      const jwk = await new DeviceKey(keychain, machine).prepareRotation();
      out(`A new device key for "${machine}" is pending (kid ${jwk.kid}):`);
      out(publicJson(jwk));
      out("");
      out("The running agent announces it over its authenticated socket the next time it connects.");
      out("To announce it now:");
      out(`  launchctl kill SIGHUP gui/$(id -u)/${LAUNCHD_LABEL}`);
      out("The agent switches to the new key once the cloud confirms it; the old key stops working after that.");
      return 0;
    }
    case "doctor":
      return doctor(configPath, keychain, out, args.verbose);
    case "run":
      await runDaemon(configPath);
      return undefined; // keeps running
    case "help":
    case undefined:
      out(USAGE);
      return args.command === undefined ? 1 : 0;
    default:
      out(USAGE);
      throw new Error(`unknown command: ${args.command}`);
  }
}

/** True when a tool result's text is an empty JSON list or object, or there is no text at all. */
function looksEmpty(content: Array<Record<string, unknown>>): boolean {
  const text = content
    .map((b) => (b.type === "text" && typeof b.text === "string" ? b.text : ""))
    .join("")
    .trim();
  if (text === "") return true;
  try {
    const value: unknown = JSON.parse(text);
    if (Array.isArray(value)) return value.length === 0;
    if (value && typeof value === "object") {
      const values = Object.values(value);
      return values.length === 0 || values.every((v) => Array.isArray(v) && v.length === 0);
    }
  } catch {
    // not JSON: some text came back, which is enough
  }
  return false;
}

async function doctor(configPath: string, keychain: Keychain, out: (line: string) => void, verbose: boolean): Promise<number> {
  let problems = 0;
  const ok = (text: string) => out(`  ok    ${text}`);
  const bad = (text: string) => {
    problems++;
    out(`  FAIL  ${text}`);
  };
  const warn = (text: string) => out(`  warn  ${text}`);

  out(`local-bridge-agent ${AGENT_VERSION} doctor`);
  out("");
  out("Config");
  let config: Config;
  try {
    config = await loadConfig(configPath);
    ok(`${configPath}: machine "${config.machine}", endpoint ${config.endpoint}, ${Object.keys(config.servers).length} server(s)`);
  } catch (err) {
    bad(err instanceof Error ? err.message : String(err));
    return 1;
  }

  out("");
  out("Device key");
  try {
    const key = new DeviceKey(keychain, config.machine);
    const jwk = await key.publicJwk();
    if (jwk) ok(`present in the Keychain, kid ${jwk.kid}`);
    else bad("no device key in the Keychain; run: local-bridge-agent init");
    const pending = await key.pendingPublicJwk();
    if (pending && pending.kid !== jwk?.kid) warn(`a rotation key is pending, kid ${pending.kid}`);
  } catch (err) {
    bad(err instanceof Error ? err.message : String(err));
  }

  out("");
  out("Keychain values");
  let secrets: string[] = [];
  let resolved = config;
  try {
    const r = await resolveSecrets(config, keychain);
    resolved = r.config;
    secrets = r.secrets;
    ok(`${secrets.length} keychain: reference(s) resolved`);
  } catch (err) {
    bad(err instanceof Error ? err.message : String(err));
  }

  out("");
  out("Servers");
  const manager = new ServerManager(resolved.servers, { secrets, stdioStderr: verbose ? "inherit" : "ignore" });
  try {
    await manager.start();
    for (const report of manager.report()) {
      const serverConfig = resolved.servers[report.name];
      if (report.status !== "up") {
        bad(`${report.name}: down${report.error ? ` (${report.error})` : ""}`);
        continue;
      }
      ok(`${report.name}: up, ${report.exposed.length} tool(s) exposed`);
      for (const tool of report.exposed) out(`          ${tool.access.padEnd(5)}  ${tool.name}`);
      if (report.unexposed.length > 0) {
        out(`        offered by the server but NOT exposed by the config (${report.unexposed.length}):`);
        for (const name of report.unexposed) out(`          -      ${name}`);
      }
      for (const name of report.missing) {
        problems++;
        out(`  FAIL  ${report.name}: the config names "${name}" but the server does not offer it`);
      }
      // A missing Reminders grant exits 0 and returns nothing, so look at an actual answer.
      if (serverConfig && kindOf(serverConfig) === "apple-reminders-mcp" && report.exposed.some((t) => t.name === "list_reminder_lists")) {
        const res = await manager.callTool(report.name, "list_reminder_lists", {}, {
          callId: "doctor",
          deadline: Date.now() + 20_000,
          maxResultBytes: 1_048_576,
        });
        if (!res.ok) bad(`${report.name}: list_reminder_lists failed: ${res.error.message}`);
        else if (res.result.isError || looksEmpty(res.result.content)) {
          bad(`${report.name}: list_reminder_lists returned nothing; the Reminders permission is probably not granted`);
        } else ok(`${report.name}: list_reminder_lists returned data, so Reminders access works`);
      }
    }
  } finally {
    await manager.stop();
  }

  out("");
  out("macOS permissions these servers need (granted to the node binary the LaunchAgent runs)");
  out(formatTable(permissionRows(config.servers)).replace(/^/gm, "  "));
  out("");
  out(problems === 0 ? "No problems found." : `${problems} problem(s) found.`);
  return problems === 0 ? 0 : 1;
}
