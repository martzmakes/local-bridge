// Machine config: ~/.config/local-bridge/config.json (spec section 10).
// This file is the machine-side allowlist: a tool exists for the cloud only if
// it is named under a server's `read` or `write` list here.
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { ENDPOINT_ID_RE } from "../../infra/lib/shared/mcp-path";
import { NAME_RE, type Access } from "../../infra/lib/shared/protocol";
import { isKeychainRef, type Keychain } from "./keychain";

const Name = z.string().regex(NAME_RE, "must match [a-z0-9]{1,16}");
const ToolName = z.string().min(1).max(128);
const ToolList = z.array(ToolName).max(500).default([]);

const exposure = {
  endpointId: z.string().length(36).regex(ENDPOINT_ID_RE).optional(),
  /** Shown to MCP clients and in the macOS app. */
  title: z.string().min(1).max(64).optional(),
  /** false: the server is not started, not announced, and calls to it are `not_exposed`. */
  enabled: z.boolean().default(true),
  read: ToolList,
  write: ToolList,
  /** Calls run at once against this server. AppleScript-backed servers want 1. */
  concurrency: z.number().int().min(1).max(4).default(1),
  /** Upper bound for one call, applied on top of the cloud's deadline. */
  callTimeoutMs: z.number().int().positive().max(600_000).optional(),
};

const StdioServer = z.strictObject({
  transport: z.literal("stdio"),
  command: z.string().min(1),
  args: z.array(z.string()).default([]),
  env: z.record(z.string(), z.string()).optional(),
  cwd: z.string().min(1).optional(),
  ...exposure,
});

const HttpUrl = z.string().refine((v) => {
  try {
    const u = new URL(v);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}, "must be an http(s) URL");

const RemoteServer = z.strictObject({
  transport: z.enum(["sse", "http"]),
  url: HttpUrl,
  headers: z.record(z.string(), z.string()).optional(),
  ...exposure,
});

export const ServerConfigSchema = z.discriminatedUnion("transport", [StdioServer, RemoteServer]);
export type ServerConfig = z.infer<typeof ServerConfigSchema>;

const Endpoint = z.string().refine((v) => {
  try {
    const u = new URL(v);
    if (u.protocol === "wss:") return true;
    // Plain ws is only for a test server on this machine.
    return u.protocol === "ws:" && ["localhost", "127.0.0.1", "[::1]"].includes(u.hostname);
  } catch {
    return false;
  }
}, "must be a wss:// URL (ws:// is accepted for localhost only)");

export const DEFAULT_PUBLIC_BASE = "https://bridge.martzmakes.com";

const PublicBase = z.string().refine((v) => {
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
}, "must be an https:// URL");

export const ACCOUNT_RE = /^[a-f0-9]{20}$/;
export const NO_ACCOUNT_MESSAGE = "this Mac is not signed in to an account; open the Local Bridge app and sign in";

export const ConfigSchema = z.strictObject({
  machine: Name,
  endpoint: Endpoint,
  /** The account this Mac belongs to (mac-app spec section 9); the app writes it after sign-in. `run` needs it. */
  account: z.string().regex(ACCOUNT_RE, "must be 20 lowercase hex characters").optional(),
  /** Where MCP clients reach the bridge. The agent never connects to it; the app shows endpoint URLs from it. */
  publicBase: PublicBase.default(DEFAULT_PUBLIC_BASE),
  servers: z
    .record(z.string(), ServerConfigSchema)
    .refine((s) => Object.keys(s).every((k) => NAME_RE.test(k)), "server names must match [a-z0-9]{1,16}")
    .refine((s) => Object.keys(s).length <= 32, "at most 32 servers"),
});
export type Config = z.infer<typeof ConfigSchema>;

export class ConfigError extends Error {
  override name = "ConfigError";
}

export function defaultConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  return env.LOCAL_BRIDGE_CONFIG || join(homedir(), ".config", "local-bridge", "config.json");
}

export function parseConfig(input: unknown): Config {
  const parsed = ConfigSchema.safeParse(input);
  if (!parsed.success) throw new ConfigError(`invalid config:\n${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Reads and validates the config. Refuses a file other users can read. */
export async function loadConfig(path: string = defaultConfigPath()): Promise<Config> {
  let mode: number;
  try {
    mode = (await stat(path)).mode;
  } catch {
    throw new ConfigError(`config file not found: ${path}`);
  }
  if ((mode & 0o077) !== 0) {
    throw new ConfigError(
      `config file ${path} is readable by group or others (mode ${(mode & 0o777).toString(8)}); run: chmod 600 ${path}`,
    );
  }
  let json: unknown;
  try {
    json = JSON.parse(await readFile(path, "utf8"));
  } catch {
    // The parser's message can quote file content, which may hold a token.
    throw new ConfigError(`config file ${path} is not valid JSON`);
  }
  return parseConfig(json);
}

/** The config's exposure decision for one tool. A name in both lists is `write`. */
export function accessFor(server: Pick<ServerConfig, "read" | "write">, tool: string): Access | undefined {
  if (server.write.includes(tool)) return "write";
  if (server.read.includes(tool)) return "read";
  return undefined;
}

export interface ResolvedConfig {
  config: Config;
  /** Values pulled from the Keychain, so callers can scrub them from error text. */
  secrets: string[];
}

/** Replaces every `keychain:<service>` value in one server's env or headers. Resolved values are appended to `secrets`. */
export async function resolveServerSecrets(server: ServerConfig, keychain: Keychain, secrets: string[] = []): Promise<ServerConfig> {
  const resolveMap = async (map: Record<string, string> | undefined): Promise<Record<string, string> | undefined> => {
    if (!map) return map;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
      if (isKeychainRef(v)) {
        const secret = await keychain.resolveRef(v);
        secrets.push(secret);
        out[k] = secret;
      } else {
        out[k] = v;
      }
    }
    return out;
  };
  return server.transport === "stdio"
    ? { ...server, env: await resolveMap(server.env) }
    : { ...server, headers: await resolveMap(server.headers) };
}

/** Replaces every `keychain:<service>` value in server env and headers. Disabled servers are left alone. */
export async function resolveSecrets(config: Config, keychain: Keychain): Promise<ResolvedConfig> {
  const secrets: string[] = [];
  const servers: Config["servers"] = {};
  for (const [name, server] of Object.entries(config.servers)) {
    // A disabled server is never started, so a missing Keychain item for it must not stop the agent.
    servers[name] = server.enabled ? await resolveServerSecrets(server, keychain, secrets) : server;
  }
  return { config: { ...config, servers }, secrets };
}
