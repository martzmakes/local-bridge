// The bridge's MCP surface: tools/list and tools/call for one authenticated
// agent. Everything a call goes through, in order (spec section 4):
// agent check, rate limit, tool lookup, allowlist, argument policy, payload
// limit, forward, result filter, audit.
import { randomUUID } from "crypto";
import { OFFLINE_AFTER_MS, type ToolInfo, type ToolResult } from "../../shared/protocol";
import { argsHash, buildAuditRow, type AuditRow, type Outcome } from "../bridge/audit";
import { dispatchCall, type DispatchDeps, type DispatchOutcome } from "../bridge/dispatch";
import { canonicalId, wireName, type ToolRef } from "../bridge/names";
import { applyArgPolicy, applyResultPolicy, decide, PolicyError, resultBytes, type Rule } from "../bridge/policy";
import { checkRate } from "../bridge/ratelimit";
import {
  AGENT_DEFAULTS,
  HARD_MAX_CALL_TIMEOUT_MS,
  HARD_MAX_RESULT_BYTES,
  type AgentMeta,
  type Machine,
} from "../bridge/store";

export const HEALTH_TOOL = "bridge_health";

/**
 * The built-in agent a connector sign-in acts as. The owner may use every tool
 * a machine announces; what a machine announces is what its app has switched
 * on, so the app is the control (v2 spec section 3). Other agents need rules.
 */
export const OWNER_AGENT = "owner";

/** One local server's endpoint: /mcp/<machine>/<server>. Absent on the aggregate /mcp. */
export interface Scope {
  machine: string;
  server: string;
}

export interface Caller {
  agent: string;
  tokenKind: "oauth" | "minted";
  /** Token version claim; only minted tokens carry one. */
  tv?: number;
}

export interface BridgeDeps extends DispatchDeps {
  getAgent(id: string): Promise<{ meta: AgentMeta; rules: Rule[] } | null>;
  listMachines(): Promise<Machine[]>;
  takeRate(agent: string, window: string, limit: number, ttlSeconds: number): Promise<boolean>;
  putAudit(row: AuditRow): Promise<void>;
  hmacKey(): Promise<string>;
  listStaleTools: boolean;
  auditRetentionDays: number;
  newCallId?: () => string;
}

export interface McpTool {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations?: Record<string, unknown>;
}

export interface McpToolResult {
  content: Array<Record<string, unknown>>;
  structuredContent?: Record<string, unknown>;
  isError: boolean;
}

function errorResult(message: string): McpToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

function isConnected(m: Machine, now: number): boolean {
  return (
    m.meta.enabled &&
    m.meta.connectionId !== undefined &&
    m.meta.lastSeenAt !== undefined &&
    now - m.meta.lastSeenAt <= OFFLINE_AFTER_MS
  );
}

/** Agent state for a caller: usable only if the row exists, is enabled, and the token is current. */
async function loadAgent(caller: Caller, deps: BridgeDeps): Promise<{ meta: AgentMeta; rules: Rule[] } | { denied: "agent_unknown" | "agent_disabled" | "token_revoked" }> {
  let agent = await deps.getAgent(caller.agent);
  // A connector sign-in needs no row: the owner exists implicitly with the
  // default limits. A row named "owner" overrides those limits or disables it.
  if (!agent && caller.agent === OWNER_AGENT && caller.tokenKind === "oauth") {
    agent = { meta: { ...AGENT_DEFAULTS, id: OWNER_AGENT, createdAt: 0 }, rules: [] };
  }
  if (!agent) return { denied: "agent_unknown" };
  if (!agent.meta.enabled) return { denied: "agent_disabled" };
  if (caller.tokenKind === "minted" && (caller.tv ?? 0) < agent.meta.tokenVersion) return { denied: "token_revoked" };
  return agent;
}

/** The allowlist decision for one tool. The owner is allowed whatever the machine announces. */
function authorize(agent: { meta: AgentMeta; rules: Rule[] }, ref: ToolRef, access: ToolInfo["access"]): ReturnType<typeof decide> {
  if (agent.meta.id === OWNER_AGENT) return { allowed: true, rule: { tool: canonicalId(ref), access } };
  return decide(agent.rules, ref, access);
}

interface CatalogEntry {
  ref: ToolRef;
  tool: ToolInfo;
  machine: Machine;
  serverStatus: "up" | "down";
  serverError?: string;
}

/**
 * Tools by the name clients use. On the aggregate endpoint that is the
 * namespaced wire name; on a server's own endpoint it is the tool's original
 * name, untouched, and only that server's tools exist.
 */
function catalog(machines: Machine[], scope?: Scope): Map<string, CatalogEntry> {
  const out = new Map<string, CatalogEntry>();
  for (const machine of machines) {
    if (scope && machine.meta.id !== scope.machine) continue;
    for (const server of machine.servers) {
      if (scope && server.name !== scope.server) continue;
      for (const tool of server.tools) {
        const ref = { machine: machine.meta.id, server: server.name, tool: tool.name };
        out.set(scope ? tool.name : wireName(ref), { ref, tool, machine, serverStatus: server.status, serverError: server.error });
      }
    }
  }
  return out;
}

/** The server row an endpoint points at, if the machine has announced it. */
export function findServer(machines: Machine[], scope: Scope) {
  return machines.find((m) => m.meta.id === scope.machine)?.servers.find((s) => s.name === scope.server);
}

/** Hides arguments the agent's rule forces or forbids, so the model does not try to set them. */
function schemaForRule(schema: Record<string, unknown>, rule: Rule): Record<string, unknown> {
  const hidden = new Set([...Object.keys(rule.args?.force ?? {}), ...(rule.args?.deny ?? [])]);
  if (hidden.size === 0) return schema;
  const props = schema.properties;
  if (!props || typeof props !== "object") return schema;
  const properties = Object.fromEntries(Object.entries(props as Record<string, unknown>).filter(([k]) => !hidden.has(k)));
  const required = Array.isArray(schema.required) ? schema.required.filter((k) => !hidden.has(String(k))) : undefined;
  return { ...schema, properties, ...(required ? { required } : {}) };
}

const HEALTH_DEF: McpTool = {
  name: HEALTH_TOOL,
  title: "Local Bridge health",
  description:
    "Reports which of the owner's machines are connected to Local Bridge and which local servers on each are up, with the number of tools you are allowed to use on each. " +
    "Call this when a bridged tool is missing from your tool list or fails with an offline, not responding or down error, before telling the user a machine is unavailable. Takes no arguments.",
  inputSchema: { type: "object", properties: {} },
  annotations: { readOnlyHint: true },
};

export async function listTools(caller: Caller, deps: BridgeDeps, scope?: Scope): Promise<McpTool[]> {
  const agent = await loadAgent(caller, deps);
  if ("denied" in agent) return [HEALTH_DEF];
  const now = deps.now();
  const tools: McpTool[] = [HEALTH_DEF];
  for (const [name, entry] of catalog(await deps.listMachines(), scope)) {
    if (!entry.machine.meta.enabled) continue;
    if (!deps.listStaleTools && (!isConnected(entry.machine, now) || entry.serverStatus !== "up")) continue;
    const decision = authorize(agent, entry.ref, entry.tool.access);
    if (!decision.allowed) continue;
    const readOnly = entry.tool.access === "read";
    if (scope) {
      // Straight through: the local server's own name, description and schema.
      tools.push({
        name,
        description: entry.tool.description ?? "",
        inputSchema: schemaForRule(entry.tool.inputSchema, decision.rule),
        annotations: { readOnlyHint: readOnly },
      });
      continue;
    }
    tools.push({
      name,
      title: canonicalId(entry.ref),
      description: `[${entry.ref.machine} / ${entry.ref.server}, ${readOnly ? "read-only" : "WRITE"}] ${entry.tool.description ?? ""}`.trim(),
      inputSchema: schemaForRule(entry.tool.inputSchema, decision.rule),
      annotations: { readOnlyHint: readOnly },
    });
  }
  return tools;
}

export async function health(caller: Caller, deps: BridgeDeps, scope?: Scope): Promise<McpToolResult> {
  const agent = await loadAgent(caller, deps);
  const allowed = (ref: ToolRef, access: ToolInfo["access"]) => !("denied" in agent) && authorize(agent, ref, access).allowed;
  const now = deps.now();
  const machines = (await deps.listMachines()).filter((m) => !scope || m.meta.id === scope.machine).map((m) => ({
    machine: m.meta.id,
    connected: isConnected(m, now),
    enabled: m.meta.enabled,
    lastSeen: m.meta.lastSeenAt ? new Date(m.meta.lastSeenAt).toISOString() : null,
    agentVersion: m.meta.agentVersion ?? null,
    servers: m.servers.filter((s) => !scope || s.name === scope.server).map((s) => ({
      server: s.name,
      ...(s.title ? { title: s.title } : {}),
      status: isConnected(m, now) ? s.status : "unreachable",
      ...(s.error ? { error: s.error } : {}),
      toolsAvailableToYou: s.tools.filter((t) => allowed({ machine: m.meta.id, server: s.name, tool: t.name }, t.access)).length,
    })),
  }));
  const body = {
    agent: caller.agent,
    ...("denied" in agent ? { agentStatus: agent.denied } : {}),
    checkedAt: new Date(now).toISOString(),
    machines,
  };
  return { content: [{ type: "text", text: JSON.stringify(body, null, 2) }], structuredContent: body, isError: false };
}

const DISPATCH_OUTCOME: Record<Exclude<DispatchOutcome, { ok: true }>["failure"], Outcome> = {
  not_registered: "offline",
  machine_disabled: "offline",
  offline: "offline",
  reconnecting: "offline",
  not_responding: "offline",
  timeout: "timeout",
  machine_error: "tool_error",
  bridge_error: "bridge_error",
};

export async function callTool(caller: Caller, name: string, rawArgs: Record<string, unknown>, deps: BridgeDeps, scope?: Scope): Promise<McpToolResult> {
  if (name === HEALTH_TOOL) return health(caller, deps, scope);

  const started = deps.now();
  const callId = (deps.newCallId ?? randomUUID)();
  const argBytes = Buffer.byteLength(JSON.stringify(rawArgs), "utf8");
  let toolLabel = scope ? `${scope.machine}.${scope.server}.${name}` : name;
  let machineId: string | undefined = scope?.machine;
  let hash = "";

  const finish = async (outcome: Outcome, reason: string | undefined, result: McpToolResult, size = 0): Promise<McpToolResult> => {
    try {
      if (!hash) hash = argsHash(rawArgs, await deps.hmacKey());
      await deps.putAudit(
        buildAuditRow(
          {
            ts: started,
            callId,
            agent: caller.agent,
            tool: toolLabel,
            machine: machineId,
            outcome,
            reason,
            argsHash: hash,
            argBytes,
            resultBytes: size,
            latencyMs: deps.now() - started,
            tokenKind: caller.tokenKind,
          },
          deps.auditRetentionDays
        )
      );
    } catch {
      // An unaudited call must not return data.
      return errorResult(`bridge error ${callId} (audit unavailable)`);
    }
    return result;
  };

  const agent = await loadAgent(caller, deps);
  if ("denied" in agent) {
    return finish("denied", agent.denied, errorResult(`agent "${caller.agent}" is not permitted to use this bridge (${agent.denied})`));
  }
  const limits = { ...AGENT_DEFAULTS, ...agent.meta };

  const rate = await checkRate(caller.agent, limits, deps);
  if (!rate.ok) {
    return finish("rate_limited", rate.window, errorResult(`rate limit reached for agent "${caller.agent}", retry after ${rate.retryAfterSeconds} s`));
  }

  const machines = await deps.listMachines();
  if (scope && !findServer(machines, scope)) {
    return finish("denied", "unknown_endpoint", errorResult(`${scope.machine}/${scope.server} is not available. Call ${HEALTH_TOOL} for details.`));
  }
  const entry = catalog(machines, scope).get(name);
  // An unknown tool and a tool the agent may not use give the same answer, so
  // an agent cannot probe for what exists.
  const notPermitted = () => errorResult(`tool "${name}" is not available to agent "${caller.agent}"`);
  if (!entry) return finish("denied", "unknown_tool", notPermitted());
  toolLabel = canonicalId(entry.ref);
  machineId = entry.ref.machine;

  const decision = authorize(agent, entry.ref, entry.tool.access);
  if (!decision.allowed) return finish("denied", decision.reason, notPermitted());

  if (argBytes > limits.maxArgBytes) {
    return finish("too_large", "args", errorResult(`arguments too large (${argBytes} bytes, limit ${limits.maxArgBytes})`));
  }

  let args: Record<string, unknown>;
  try {
    args = applyArgPolicy(decision.rule, rawArgs);
  } catch (err) {
    if (err instanceof PolicyError) return finish("denied", err.reason, errorResult(err.message));
    throw err;
  }

  if (entry.serverStatus !== "up" && entry.machine.meta.connectionId) {
    return finish("offline", "server_down", errorResult(`${entry.ref.machine}.${entry.ref.server} is down. Call ${HEALTH_TOOL} for details.`));
  }

  const maxResultBytes = Math.min(limits.maxResultBytes, decision.rule.result?.maxBytes ?? limits.maxResultBytes, HARD_MAX_RESULT_BYTES);
  const outcome = await dispatchCall(
    {
      callId,
      agent: caller.agent,
      machine: entry.ref.machine,
      server: entry.ref.server,
      tool: entry.ref.tool,
      args,
      timeoutMs: Math.min(limits.callTimeoutMs, HARD_MAX_CALL_TIMEOUT_MS),
      // Filters shrink a result, so let the machine send up to the hard
      // ceiling when a filter is present and enforce the agent's limit after.
      maxResultBytes: decision.rule.result?.items ? HARD_MAX_RESULT_BYTES : maxResultBytes,
    },
    deps
  );
  if (!outcome.ok) {
    const auditOutcome = outcome.machineCode === "too_large" ? "too_large" : outcome.machineCode === "timeout" ? "timeout" : DISPATCH_OUTCOME[outcome.failure];
    return finish(auditOutcome, outcome.machineCode ?? outcome.failure, errorResult(outcome.message));
  }

  let filtered: ToolResult;
  try {
    filtered = applyResultPolicy(decision.rule, outcome.result, maxResultBytes);
  } catch (err) {
    if (err instanceof PolicyError) {
      return finish(err.reason === "result_too_large" ? "too_large" : "filtered_out", err.reason, errorResult(err.message));
    }
    throw err;
  }
  const size = resultBytes(filtered);
  return finish(
    filtered.isError ? "tool_error" : "ok",
    undefined,
    {
      content: filtered.content,
      ...(filtered.structuredContent ? { structuredContent: filtered.structuredContent } : {}),
      isError: filtered.isError === true,
    },
    size
  );
}
