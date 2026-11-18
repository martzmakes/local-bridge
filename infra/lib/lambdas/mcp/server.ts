// MCP server Lambda: JSON-RPC 2.0 over HTTP POST (Streamable HTTP, stateless).
// Auth: Bearer JWT carrying a bridge agent, issued by the OAuth flow (connector
// sign-in) or by infra/scripts/mint.ts (machine tokens).
//
// The tool surface lives in ./bridge.ts. This file is transport, auth and
// JSON-RPC dispatch, and it never logs request or response bodies.
import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { randomUUID } from "crypto";
import {
  CallToolRequestSchema,
  JSONRPCRequestSchema,
  JSONRPCNotificationSchema,
  LATEST_PROTOCOL_VERSION,
  SUPPORTED_PROTOCOL_VERSIONS,
} from "@modelcontextprotocol/sdk/types.js";
import { mcpPath } from "../../shared/mcp-path";
import { verifyJwt } from "../auth/lib/jwt";
import { GoneError } from "../bridge/dispatch";
import { isValidAgentId } from "../bridge/names";
import { ConnectionGone, errName, getSecret, getStore, logEvent, pushToConnection } from "../bridge/runtime";
import { uidFromEmail } from "../bridge/tenant";
import { callTool, findServer, listTools, resolveEndpoint, type BridgeDeps, type Caller, type Scope } from "./bridge";

const PROJECT_SLUG = process.env.PROJECT_SLUG!;
const DOMAIN = process.env.DOMAIN!;
const MCP_PUBLIC_BASE = process.env.MCP_PUBLIC_BASE || `https://${DOMAIN}`;
const MAX_BODY_BYTES = 131_072;

const SERVER_INFO = { name: PROJECT_SLUG, title: "Local Bridge", version: "0.1.0" };
const OFFLINE_NOTE =
  "The machine can be asleep or offline: calls then fail within a few seconds with a clear error, and bridge_health reports what is up.";
const INSTRUCTIONS =
  "Local Bridge forwards tool calls to MCP servers running on the owner's own Macs. Tool names are <machine>__<server>__<tool>. " +
  OFFLINE_NOTE + " You only see tools this connection has been granted.";

/** Everything a request can touch, bound to the account of its verified token. */
function deps(uid: string): BridgeDeps {
  const store = getStore().forTenant(uid);
  return {
    getAgent: (id) => store.getAgent(id),
    listMachines: () => store.listMachines(),
    takeRate: (a, w, l, t) => store.takeRate(a, w, l, t),
    putAudit: (row) => store.putAudit(row),
    hmacKey: () => getSecret(process.env.AUDIT_HMAC_PARAM!),
    listStaleTools: process.env.LIST_STALE_TOOLS === "true",
    auditRetentionDays: Number(process.env.AUDIT_RETENTION_DAYS || "90"),
    getMachine: (id) => store.getMachine(id),
    createCall: (c, m, a) => store.createCall(c, m, a),
    getCall: (c) => store.getCall(c),
    readResult: (c) => store.readResult(c),
    abandonCall: (c, m) => store.abandonCall(c, m),
    deleteCall: (c, n) => store.deleteCall(c, n),
    push: async (connectionId, message) => {
      try {
        await pushToConnection(connectionId, message);
      } catch (err) {
        if (err instanceof ConnectionGone) throw new GoneError();
        throw err;
      }
    },
    now: Date.now,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  };
}

// ---------------------------------------------------------------------------
// JSON-RPC helpers
// ---------------------------------------------------------------------------

type Id = string | number | null;
type JsonRpcResponse = {
  jsonrpc: "2.0";
  id: Id;
  result?: unknown;
  error?: { code: number; message: string };
};

const ok = (id: Id, result: unknown): JsonRpcResponse => ({ jsonrpc: "2.0", id, result });
const rpcErr = (id: Id, code: number, message: string): JsonRpcResponse => ({ jsonrpc: "2.0", id, error: { code, message } });

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-methods": "GET,POST,DELETE,OPTIONS",
    "access-control-allow-headers": "authorization,content-type,mcp-session-id,mcp-protocol-version",
    "access-control-expose-headers": "mcp-session-id,www-authenticate",
  };
}

function httpJson(statusCode: number, body: unknown, extra: Record<string, string> = {}) {
  return {
    statusCode,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...corsHeaders(), ...extra },
    body: JSON.stringify(body),
  };
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

export async function dispatch(caller: Caller, raw: unknown, d: BridgeDeps, scope?: Scope): Promise<JsonRpcResponse | null> {
  if ((raw as { id?: unknown } | null)?.id === undefined && JSONRPCNotificationSchema.safeParse(raw).success) return null;
  const parsed = JSONRPCRequestSchema.safeParse(raw);
  if (!parsed.success) return rpcErr(null, -32600, "Invalid request");
  const req = parsed.data;
  const id = req.id as Id;

  try {
    switch (req.method) {
      case "initialize": {
        const requested = (req.params as { protocolVersion?: string } | undefined)?.protocolVersion;
        const protocolVersion = requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
        if (scope) {
          // A server's own endpoint presents itself as that server.
          const title = findServer(await d.listMachines(), scope)?.title ?? scope.server;
          return ok(id, {
            protocolVersion,
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: `${scope.machine}-${scope.server}`, title: `${title} (${scope.machine})`, version: SERVER_INFO.version },
            instructions: `"${title}" is an MCP server running on the owner's Mac "${scope.machine}", reached through Local Bridge. ${OFFLINE_NOTE}`,
          });
        }
        return ok(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        });
      }
      case "ping":
        return ok(id, {});
      case "tools/list":
        return ok(id, { tools: await listTools(caller, d, scope) });
      case "tools/call": {
        const call = CallToolRequestSchema.safeParse(req);
        if (!call.success) return rpcErr(id, -32602, "Invalid tools/call parameters");
        const result = await callTool(caller, call.data.params.name, (call.data.params.arguments ?? {}) as Record<string, unknown>, d, scope);
        return ok(id, result);
      }
      case "resources/list":
        return ok(id, { resources: [] });
      case "resources/templates/list":
        return ok(id, { resourceTemplates: [] });
      case "prompts/list":
        return ok(id, { prompts: [] });
      default:
        return rpcErr(id, -32601, `Method not found: ${req.method}`);
    }
  } catch (err) {
    // Internal failures: the class name goes to the log, nothing specific to the client.
    logEvent("mcp_dispatch_error", { method: req.method, agent: caller.agent, error: errName(err) });
    return rpcErr(id, -32603, "Internal bridge error");
  }
}

// ---------------------------------------------------------------------------
// Auth
// ---------------------------------------------------------------------------

/** Auth is shared: any valid bridge token works on every endpoint. What it may do there is policy. */
export async function authenticate(authHeader: string | undefined): Promise<(Caller & { uid: string }) | null> {
  const match = /^Bearer\s+(.+)$/i.exec(authHeader ?? "");
  if (!match) return null;
  let claims;
  try {
    claims = await verifyJwt(match[1]);
  } catch {
    return null;
  }
  // The web sign-in session JWT has no agent and is not a bridge credential.
  if (!claims.agent || !claims.kind || !isValidAgentId(claims.agent)) return null;
  return { agent: claims.agent, tokenKind: claims.kind, tv: claims.tv, uid: uidFromEmail(claims.email) };
}

function unauthorized(path: string) {
  // RFC 9728: point clients at the metadata for this exact resource.
  const wwwAuth = `Bearer resource_metadata="${MCP_PUBLIC_BASE}/.well-known/oauth-protected-resource${path}"`;
  return httpJson(401, { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Unauthorized" } }, { "www-authenticate": wwwAuth });
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const method = event.requestContext.http.method;
  if (method === "OPTIONS") return { statusCode: 204, headers: corsHeaders(), body: "" };

  const target = mcpPath(event.rawPath || "");
  if (!target) return httpJson(404, { error: "not_found" });

  // We do not push server-initiated messages, so there is no SSE stream to open.
  if (method === "GET") return httpJson(405, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Streaming GET not supported" } }, { allow: "POST" });
  // Stateless: nothing to tear down.
  if (method === "DELETE") return { statusCode: 204, headers: corsHeaders(), body: "" };
  if (method !== "POST") return httpJson(405, { jsonrpc: "2.0", id: null, error: { code: -32000, message: "Method not allowed" } });

  const caller = await authenticate(event.headers?.authorization || event.headers?.Authorization);
  if (!caller) return unauthorized(target.path);

  const body = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
  if (Buffer.byteLength(body, "utf8") > MAX_BODY_BYTES) {
    return httpJson(413, { jsonrpc: "2.0", id: null, error: { code: -32600, message: `Request too large (limit ${MAX_BODY_BYTES} bytes)` } });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return httpJson(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
  }

  const incomingSession = event.headers?.["mcp-session-id"] || event.headers?.["Mcp-Session-Id"];
  const isInitialize = !Array.isArray(parsed) && (parsed as { method?: string } | null)?.method === "initialize";
  const sessionHeader = { "mcp-session-id": isInitialize ? randomUUID() : incomingSession || randomUUID() };
  const accepted = { statusCode: 202, headers: { ...corsHeaders(), ...sessionHeader }, body: "" };

  const d = deps(caller.uid);
  let scope: Scope | undefined;
  if (target.endpointId) {
    try {
      const machines = await d.listMachines();
      scope = resolveEndpoint(machines, target.endpointId);
      if (!scope) return httpJson(404, { error: "not_found" });
      // Dispatch from the same tenant catalog that resolved the UUID.
      d.listMachines = async () => machines;
    } catch (err) {
      logEvent("mcp_catalog_error", { error: errName(err) });
      return httpJson(500, { error: "server_error" });
    }
  }

  if (Array.isArray(parsed)) {
    // Batches run in order, not in parallel, so one request cannot fan out
    // past the machine's concurrency.
    if (parsed.length > 10) return httpJson(400, { jsonrpc: "2.0", id: null, error: { code: -32600, message: "Batch too large" } });
    const results: JsonRpcResponse[] = [];
    for (const item of parsed) {
      const r = await dispatch(caller, item, d, scope);
      if (r) results.push(r);
    }
    return results.length ? httpJson(200, results, sessionHeader) : accepted;
  }
  const result = await dispatch(caller, parsed, d, scope);
  return result ? httpJson(200, result, sessionHeader) : accepted;
};
