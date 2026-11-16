// `inspect`: start one server, list every tool it offers, stop it (mac-app spec section 5).
// The macOS app runs this while a server is being added, before anything is exposed.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import type { Access } from "../../infra/lib/shared/protocol";
import { ServerConfigSchema, resolveServerSecrets, type ServerConfig } from "./config";
import type { Keychain } from "./keychain";
import { createTransport } from "./servers";
import { AGENT_VERSION } from "./version";

export const INSPECT_TIMEOUT_MS = 20_000;
export const INSPECT_TIMEOUT_ERROR = "timed out starting the server";

export interface InspectedTool {
  name: string;
  description: string;
  /** Present only when the server's annotations state it. */
  readOnlyHint?: boolean;
  suggestedAccess: Access;
}

export type InspectResult = { ok: true; tools: InspectedTool[] } | { ok: false; error: string };

export interface InspectOptions {
  keychain: Keychain;
  timeoutMs?: number;
}

const READ_PREFIX = /^(get|list|search|read|find)_/i;

/**
 * The default for the app's "can change things" flag. `read` needs a positive
 * sign (the server's own hint, or a conventional read-only name) and no
 * contrary annotation; everything else is `write`.
 */
export function suggestAccess(name: string, annotations?: { readOnlyHint?: unknown; destructiveHint?: unknown }): Access {
  if (annotations?.destructiveHint === true || annotations?.readOnlyHint === false) return "write";
  if (annotations?.readOnlyHint === true || READ_PREFIX.test(name)) return "read";
  return "write";
}

function shortReason(err: unknown, secrets: string[]): string {
  const code = (err as { code?: unknown } | null)?.code;
  // A spawn failure: the errno name says it all and quotes nothing.
  if (typeof code === "string" && /^E[A-Z0-9_]+$/.test(code)) return code;
  let text = err instanceof Error ? err.message : String(err);
  for (const secret of secrets) if (secret.length >= 4) text = text.split(secret).join("[redacted]");
  return text.replace(/^MCP error -?\d+:\s*/, "").replace(/\s+/g, " ").trim().slice(0, 200) || "unknown error";
}

async function listAllTools(client: Client, timeoutMs: number): Promise<InspectedTool[]> {
  const tools: InspectedTool[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < 50; page++) {
    const res = await client.listTools(cursor ? { cursor } : undefined, { timeout: timeoutMs });
    for (const tool of res.tools) {
      const readOnlyHint = tool.annotations?.readOnlyHint;
      tools.push({
        name: tool.name,
        description: (tool.description ?? "").slice(0, 8192),
        ...(typeof readOnlyHint === "boolean" ? { readOnlyHint } : {}),
        suggestedAccess: suggestAccess(tool.name, tool.annotations),
      });
    }
    cursor = res.nextCursor;
    if (!cursor) break;
  }
  return tools;
}

/** Never throws: every failure is an `ok: false` result with a short reason. */
export async function inspectServer(input: unknown, opts: InspectOptions): Promise<InspectResult> {
  const timeoutMs = opts.timeoutMs ?? INSPECT_TIMEOUT_MS;
  const parsed = ServerConfigSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return { ok: false, error: `invalid server: ${where}${issue?.message ?? "bad input"}`.slice(0, 200) };
  }

  let transport: Transport | undefined;
  let client: Client | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const secrets: string[] = [];
  const work = (async (): Promise<InspectResult> => {
    let config: ServerConfig;
    try {
      config = await resolveServerSecrets(parsed.data, opts.keychain, secrets);
    } catch (err) {
      return { ok: false, error: shortReason(err, secrets) };
    }
    try {
      transport = createTransport(config, "ignore");
      client = new Client({ name: "local-bridge-agent", version: AGENT_VERSION }, { capabilities: {} });
      client.onerror = () => {};
      await client.connect(transport, { timeout: timeoutMs });
    } catch (err) {
      return { ok: false, error: `could not start: ${shortReason(err, secrets)}` };
    }
    try {
      return { ok: true, tools: await listAllTools(client, timeoutMs) };
    } catch (err) {
      return { ok: false, error: `could not list tools: ${shortReason(err, secrets)}` };
    }
  })();
  const timeout = new Promise<InspectResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: INSPECT_TIMEOUT_ERROR }), timeoutMs);
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    work.catch(() => {});
    // Stop the server before answering, so nothing is left running. For stdio the SDK
    // closes stdin, then sends SIGTERM and SIGKILL two seconds apart.
    const closing: Promise<unknown>[] = [];
    if (client) closing.push(client.close().catch(() => {}));
    if (transport) closing.push(transport.close().catch(() => {}));
    await Promise.all(closing);
  }
}

/** Parses the JSON on stdin and inspects it. */
export async function inspectFromText(text: string, opts: InspectOptions): Promise<InspectResult> {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid server: stdin is not JSON" };
  }
  return inspectServer(input, opts);
}

export const InspectResultSchema = z.union([
  z.strictObject({
    ok: z.literal(true),
    tools: z.array(
      z.strictObject({
        name: z.string(),
        description: z.string(),
        readOnlyHint: z.boolean().optional(),
        suggestedAccess: z.enum(["read", "write"]),
      }),
    ),
  }),
  z.strictObject({ ok: z.literal(false), error: z.string() }),
]);
