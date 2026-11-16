// CLI commands: init, pubkey, rotate-key, doctor, inspect, run.
import { ConfigError, NO_ACCOUNT_MESSAGE, defaultConfigPath, loadConfig, resolveSecrets, type Config } from "./config";
import { runDaemon } from "./daemon";
import { DeviceKey, type PublicDeviceJwk } from "./device-key";
import { callFromText } from "./call";
import { inspectFromText } from "./inspect";
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
  /** Reads all of stdin; `inspect` takes its server object from it. */
  readStdin?: () => Promise<string>;
  /** Overrides call's 60 s limit in tests. */
  callTimeoutMs?: number;
  /** Overrides inspect's 20 s limit in tests. */
  inspectTimeoutMs?: number;
}

const MAX_STDIN_BYTES = 1_048_576;

async function readAllStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    const buf = typeof chunk === "string" ? Buffer.from(chunk) : (chunk as Buffer);
    size += buf.length;
    if (size > MAX_STDIN_BYTES) throw new Error("stdin is too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

const USAGE = `local-bridge-agent ${AGENT_VERSION}

Usage: local-bridge-agent <command> [--config <path>] [--machine <name>] [--verbose]

  init         Generate and store the device key if there is none; print the public JWK (one JSON line)
  pubkey       Print the public JWK of the device key
  rotate-key   Generate a pending key; the running agent announces it to the cloud
  doctor       Check config, key, each local server and the permissions they need
  inspect      Read one server object (JSON) on stdin, start it, print its tools as one JSON line
  call         Read {"server", "tool", "arguments"} (JSON) on stdin, run that tool once, print the result as one JSON line
  run          Run the agent in the foreground (what the macOS app does)

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

export async function runCli(argv: string[], deps: CliDeps = {}): Promise<number | undefined> {
  const out = deps.out ?? ((line: string) => process.stdout.write(line + "\n"));
  const keychain = deps.keychain ?? new Keychain();
  const args = parseArgs(argv);
  const configPath = args.config ?? defaultConfigPath(deps.env ?? process.env);

  switch (args.command) {
    case "init": {
      const machine = await machineName(args, configPath);
      // Creates the key only if there is none. The app registers the public half over the account API,
      // so stdout is the JWK and nothing else.
      const { jwk } = await new DeviceKey(keychain, machine).ensure();
      out(publicJson(jwk));
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
    case "inspect": {
      // Exactly one JSON line on stdout, whatever happens; needs no config file.
      let text: string;
      try {
        text = await (deps.readStdin ?? readAllStdin)();
      } catch {
        out(JSON.stringify({ ok: false, error: "could not read stdin" }));
        return 1;
      }
      const result = await inspectFromText(text, {
        keychain,
        ...(deps.inspectTimeoutMs !== undefined ? { timeoutMs: deps.inspectTimeoutMs } : {}),
      });
      out(JSON.stringify(result));
      return result.ok ? 0 : 1;
    }
    case "call": {
      // One tool, once, for the app's "Try" sheet. One JSON line on stdout; needs no config file.
      let text: string;
      try {
        text = await (deps.readStdin ?? readAllStdin)();
      } catch {
        out(JSON.stringify({ ok: false, error: "could not read stdin" }));
        return 1;
      }
      const result = await callFromText(text, {
        keychain,
        ...(deps.callTimeoutMs !== undefined ? { timeoutMs: deps.callTimeoutMs } : {}),
      });
      out(JSON.stringify(result));
      return result.ok ? 0 : 1;
    }
    case "run":
      await runDaemon(configPath, { keychain, ...(deps.env ? { env: deps.env } : {}) });
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
    ok(`public base ${config.publicBase}`);
    if (config.account) ok(`account ${config.account}`);
    else bad(`no account: ${NO_ACCOUNT_MESSAGE}`);
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
  for (const [name, server] of Object.entries(resolved.servers)) {
    if (!server.enabled) out(`  off   ${name}: disabled in the config (not started, not announced)`);
  }
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
