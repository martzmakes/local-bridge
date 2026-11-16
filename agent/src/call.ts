// `call`: start one server, run one tool once, stop it. The macOS app uses this
// for "Try a tool": the result goes to the app's sheet on stdout and nowhere
// else. Nothing here logs, and the bridge to the cloud is not involved.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { z } from "zod";
import { ServerConfigSchema, resolveServerSecrets, type ServerConfig } from "./config";
import { shortReason } from "./inspect";
import type { Keychain } from "./keychain";
import { createTransport, permissionMessage } from "./servers";
import { AGENT_VERSION } from "./version";

export const CALL_TIMEOUT_MS = 60_000;
/** A result larger than this is refused instead of printed, so one line never becomes unbounded. */
export const CALL_MAX_RESULT_BYTES = 1_048_576;

const CallInput = z.strictObject({
  server: z.unknown(),
  tool: z.string().min(1).max(128),
  arguments: z.record(z.string(), z.unknown()).default({}),
});

export type CallResult =
  | { ok: true; result: { content: unknown[]; structuredContent?: unknown; isError: boolean }; ms: number }
  | { ok: false; error: string; ms?: number };

export interface CallOnceOptions {
  keychain: Keychain;
  timeoutMs?: number;
  now?: () => number;
}

/** Never throws: every failure is an `ok: false` result with a short reason. */
export async function callOnce(input: unknown, opts: CallOnceOptions): Promise<CallResult> {
  const timeoutMs = opts.timeoutMs ?? CALL_TIMEOUT_MS;
  const now = opts.now ?? Date.now;
  const outer = CallInput.safeParse(input);
  if (!outer.success) return { ok: false, error: "invalid input: expected { server, tool, arguments }" };
  const server = ServerConfigSchema.safeParse(outer.data.server);
  if (!server.success) {
    const issue = server.error.issues[0];
    const where = issue && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
    return { ok: false, error: `invalid server: ${where}${issue?.message ?? "bad input"}`.slice(0, 200) };
  }

  let transport: Transport | undefined;
  let client: Client | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const secrets: string[] = [];
  const work = (async (): Promise<CallResult> => {
    let config: ServerConfig;
    try {
      config = await resolveServerSecrets(server.data, opts.keychain, secrets);
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
    const started = now();
    try {
      const res = await client.callTool({ name: outer.data.tool, arguments: outer.data.arguments }, undefined, { timeout: timeoutMs });
      const ms = now() - started;
      const result = {
        content: Array.isArray(res.content) ? res.content : [],
        ...(res.structuredContent !== undefined ? { structuredContent: res.structuredContent } : {}),
        isError: res.isError === true,
      };
      if (Buffer.byteLength(JSON.stringify(result), "utf8") > CALL_MAX_RESULT_BYTES) {
        return { ok: false, error: `the result is larger than ${CALL_MAX_RESULT_BYTES} bytes`, ms };
      }
      // A missing macOS permission usually comes back as an error result; say which one.
      if (result.isError) {
        const text = result.content.map((c) => (c as { text?: unknown }).text).filter((t): t is string => typeof t === "string").join("\n");
        const permission = permissionMessage(text);
        if (permission) return { ok: false, error: permission, ms };
      }
      return { ok: true, result, ms };
    } catch (err) {
      const text = err instanceof Error ? err.message : String(err);
      return { ok: false, error: permissionMessage(text) ?? `the tool failed: ${shortReason(err, secrets)}`, ms: now() - started };
    }
  })();
  const timeout = new Promise<CallResult>((resolve) => {
    timer = setTimeout(() => resolve({ ok: false, error: `timed out after ${Math.round(timeoutMs / 1000)} s`, ms: timeoutMs }), timeoutMs);
  });

  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
    work.catch(() => {});
    const closing: Promise<unknown>[] = [];
    if (client) closing.push(client.close().catch(() => {}));
    if (transport) closing.push(transport.close().catch(() => {}));
    await Promise.all(closing);
  }
}

export async function callFromText(text: string, opts: CallOnceOptions): Promise<CallResult> {
  let input: unknown;
  try {
    input = JSON.parse(text);
  } catch {
    return { ok: false, error: "invalid input: stdin is not JSON" };
  }
  return callOnce(input, opts);
}
