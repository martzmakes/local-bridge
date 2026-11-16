import { callTool, listTools, type BridgeDeps } from "../../lib/lambdas/mcp/bridge";
import type { AuditRow } from "../../lib/lambdas/bridge/audit";
import { RuleSchema, type Rule } from "../../lib/lambdas/bridge/policy";
import { AGENT_DEFAULTS, type AgentMeta, type CallMeta, type Machine } from "../../lib/lambdas/bridge/store";
import type { CloudMessage, ToolResult } from "../../lib/shared/protocol";

const T0 = Date.UTC(2026, 10, 15, 18, 0, 0);
const schema = { type: "object", properties: { query: { type: "string" }, folder: { type: "string" } }, required: ["query"] };

function mini(overrides: Partial<Machine["meta"]> = {}): Machine {
  return {
    meta: { id: "mini", enabled: true, keys: [], connectionId: "conn1", lastSeenAt: T0 - 5_000, ...overrides },
    servers: [
      {
        machine: "mini", name: "notes", status: "up", updatedAt: T0,
        tools: [
          { name: "search_notes", description: "Search notes.", inputSchema: schema, access: "read" },
          { name: "get_note", description: "Get a note.", inputSchema: { type: "object" }, access: "read" },
          { name: "create_note", description: "Create a note.", inputSchema: { type: "object" }, access: "write" },
        ],
      },
      { machine: "mini", name: "messages", status: "up", updatedAt: T0, tools: [{ name: "search_messages", inputSchema: { type: "object" }, access: "read" }] },
    ],
  };
}

function world(opts: { agents?: Record<string, { meta?: Partial<AgentMeta>; rules: Array<Partial<Rule> & { tool: string }> }>; machines?: Machine[]; reply?: (call: CloudMessage & { type: "call" }) => ToolResult | null; auditFails?: boolean } = {}) {
  let now = T0;
  const audit: AuditRow[] = [];
  const pushed: CloudMessage[] = [];
  const calls = new Map<string, CallMeta>();
  const results = new Map<string, string>();
  const counters = new Map<string, number>();
  const agents = opts.agents ?? {};
  let n = 0;
  const deps: BridgeDeps = {
    getAgent: async (id) => {
      const a = agents[id];
      if (!a) return null;
      return { meta: { ...AGENT_DEFAULTS, id, createdAt: 0, ...a.meta }, rules: a.rules.map((r) => RuleSchema.parse({ access: "read", ...r })) };
    },
    listMachines: async () => opts.machines ?? [mini()],
    getMachine: async (id) => (opts.machines ?? [mini()]).find((m) => m.meta.id === id)?.meta ?? null,
    takeRate: async (agent, window, limit) => {
      const k = `${agent}/${window}`;
      const c = counters.get(k) ?? 0;
      if (c >= limit) return false;
      counters.set(k, c + 1);
      return true;
    },
    putAudit: async (row) => {
      if (opts.auditFails) throw new Error("ddb down");
      audit.push(row);
    },
    hmacKey: async () => "test-key",
    listStaleTools: false,
    auditRetentionDays: 90,
    newCallId: () => `call-${++n}`,
    createCall: async (callId, machine, agent) => void calls.set(callId, { callId, machine, agent, status: "pending", createdAt: now }),
    getCall: async (id) => calls.get(id) ?? null,
    readResult: async (id) => results.get(id) ?? "",
    abandonCall: async (id) => void (calls.get(id)!.status = "abandoned"),
    deleteCall: async (id) => void calls.delete(id),
    push: async (_conn, message) => {
      pushed.push(message);
      if (message.type !== "call") return;
      const result = (opts.reply ?? (() => ({ content: [{ type: "text", text: "ok" }] })))(message);
      if (result) {
        results.set(message.callId, JSON.stringify(result));
        Object.assign(calls.get(message.callId)!, { status: "done", chunks: 1 });
      }
    },
    now: () => now,
    sleep: async (ms) => void (now += ms),
  };
  return { deps, audit, pushed };
}

const people = { agent: "people", tokenKind: "oauth" as const };

describe("tools/list", () => {
  it("shows an agent with no rules only bridge_health", async () => {
    const w = world({ agents: { people: { rules: [] } } });
    expect((await listTools(people, w.deps)).map((t) => t.name)).toEqual(["bridge_health"]);
  });

  it("shows an unknown or disabled agent only bridge_health", async () => {
    expect((await listTools(people, world().deps)).map((t) => t.name)).toEqual(["bridge_health"]);
    const w = world({ agents: { people: { meta: { enabled: false }, rules: [{ tool: "mini.notes.*" }] } } });
    expect((await listTools(people, w.deps)).map((t) => t.name)).toEqual(["bridge_health"]);
  });

  it("lists exactly the allowed tools; a wildcard leaves the write tool out", async () => {
    const w = world({ agents: { people: { rules: [{ tool: "mini.notes.*" }] } } });
    const tools = await listTools(people, w.deps);
    expect(tools.map((t) => t.name)).toEqual(["bridge_health", "mini__notes__search_notes", "mini__notes__get_note"]);
    expect(tools[1]).toMatchObject({ title: "mini.notes.search_notes", annotations: { readOnlyHint: true } });
    expect(tools[1].description).toBe("[mini / notes, read-only] Search notes.");
  });

  it("hides the tools of a machine that is not connected", async () => {
    const w = world({ agents: { people: { rules: [{ tool: "mini.notes.*" }] } }, machines: [mini({ connectionId: undefined })] });
    expect((await listTools(people, w.deps)).map((t) => t.name)).toEqual(["bridge_health"]);
  });

  it("removes forced arguments from the schema the model sees", async () => {
    const w = world({ agents: { people: { rules: [{ tool: "mini.notes.search_notes", args: { force: { folder: "Fitness" } } }] } } });
    const tool = (await listTools(people, w.deps))[1];
    expect(Object.keys(tool.inputSchema.properties as object)).toEqual(["query"]);
  });
});

describe("tools/call", () => {
  it("forwards an allowed call and audits it without content", async () => {
    const w = world({ agents: { people: { rules: [{ tool: "mini.notes.search_notes" }] } }, reply: () => ({ content: [{ type: "text", text: "Grocery list: eggs" }] }) });
    const out = await callTool(people, "mini__notes__search_notes", { query: "grocery" }, w.deps);
    expect(out).toEqual({ content: [{ type: "text", text: "Grocery list: eggs" }], isError: false });
    expect(w.audit).toHaveLength(1);
    expect(w.audit[0]).toMatchObject({ agent: "people", tool: "mini.notes.search_notes", machine: "mini", outcome: "ok", tokenKind: "oauth", argBytes: 19 });
    expect(w.audit[0].resultBytes).toBeGreaterThan(0);
    expect(JSON.stringify(w.audit)).not.toMatch(/grocery|eggs/i);
  });

  it("denies and audits a tool with no rule, without contacting the machine", async () => {
    const w = world({ agents: { coach: { rules: [{ tool: "mini.notes.*" }] } } });
    const out = await callTool({ agent: "coach", tokenKind: "minted", tv: 1 }, "mini__messages__search_messages", { query: "x" }, w.deps);
    expect(out.isError).toBe(true);
    expect(w.pushed).toHaveLength(0);
    expect(w.audit[0]).toMatchObject({ outcome: "denied", reason: "no_rule", tool: "mini.messages.search_messages", agent: "coach" });
  });

  it("gives the same answer for a forbidden tool and a nonexistent one", async () => {
    const w = world({ agents: { coach: { rules: [] } } });
    const coach = { agent: "coach", tokenKind: "oauth" as const };
    const a = await callTool(coach, "mini__messages__search_messages", {}, w.deps);
    const b = await callTool(coach, "mini__messages__no_such_tool", {}, w.deps);
    expect((a.content[0].text as string).replace("search_messages", "X")).toBe((b.content[0].text as string).replace("no_such_tool", "X"));
  });

  it("denies a write tool to an agent holding only the wildcard", async () => {
    const w = world({ agents: { people: { rules: [{ tool: "mini.notes.*" }] } } });
    const out = await callTool(people, "mini__notes__create_note", { title: "x" }, w.deps);
    expect(out.isError).toBe(true);
    expect(w.pushed).toHaveLength(0);
    expect(w.audit[0]).toMatchObject({ outcome: "denied", reason: "write_not_enabled" });
  });

  it("allows a write tool with an exact write rule", async () => {
    const w = world({ agents: { people: { rules: [{ tool: "mini.notes.create_note", access: "write" }] } } });
    expect((await callTool(people, "mini__notes__create_note", { title: "x" }, w.deps)).isError).toBe(false);
  });

  it("rejects a minted token older than the agent's token version, and an unknown agent", async () => {
    const w = world({ agents: { codex: { meta: { tokenVersion: 3 }, rules: [{ tool: "mini.notes.*" }] } } });
    const stale = await callTool({ agent: "codex", tokenKind: "minted", tv: 2 }, "mini__notes__search_notes", {}, w.deps);
    expect(stale.isError).toBe(true);
    expect(w.audit[0]).toMatchObject({ outcome: "denied", reason: "token_revoked" });
    expect((await callTool({ agent: "codex", tokenKind: "minted", tv: 3 }, "mini__notes__search_notes", {}, w.deps)).isError).toBe(false);
    const ghost = await callTool({ agent: "ghost", tokenKind: "minted", tv: 9 }, "mini__notes__search_notes", {}, w.deps);
    expect(ghost.isError).toBe(true);
    expect(w.pushed).toHaveLength(1);
  });

  it("sends forced arguments to the machine and applies the result filter", async () => {
    const w = world({
      agents: { people: { rules: [{ tool: "mini.messages.search_messages", args: { force: { limit: 5 } }, result: { items: { path: "messages", field: "sender", allow: "^Mom$" } } }] } },
      reply: () => ({ content: [{ type: "text", text: JSON.stringify({ messages: [{ sender: "Mom", text: "hi" }, { sender: "Other", text: "private" }] }) }] }),
    });
    const out = await callTool(people, "mini__messages__search_messages", { query: "x", limit: 500 }, w.deps);
    expect(w.pushed[0]).toMatchObject({ type: "call", arguments: { query: "x", limit: 5 } });
    expect(JSON.stringify(out)).not.toContain("private");
    expect(JSON.stringify(out)).toContain("Mom");
  });

  it("withholds a result it cannot filter", async () => {
    const w = world({
      agents: { people: { rules: [{ tool: "mini.messages.search_messages", result: { items: { path: "messages", field: "sender", allow: "^Mom$" } } }] } },
      reply: () => ({ content: [{ type: "text", text: "Other: private" }] }),
    });
    const out = await callTool(people, "mini__messages__search_messages", {}, w.deps);
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out)).not.toContain("private");
    expect(w.audit[0]).toMatchObject({ outcome: "filtered_out" });
  });

  it("enforces the per-agent rate limit and audits the refusal", async () => {
    const w = world({ agents: { people: { meta: { ratePerMinute: 2 }, rules: [{ tool: "mini.notes.*" }] } } });
    await callTool(people, "mini__notes__search_notes", {}, w.deps);
    await callTool(people, "mini__notes__search_notes", {}, w.deps);
    const third = await callTool(people, "mini__notes__search_notes", {}, w.deps);
    expect(third.content[0].text).toMatch(/rate limit/);
    expect(w.pushed).toHaveLength(2);
    expect(w.audit[2]).toMatchObject({ outcome: "rate_limited" });
  });

  it("rejects oversized arguments and oversized results", async () => {
    const w = world({ agents: { people: { meta: { maxArgBytes: 100, maxResultBytes: 200 }, rules: [{ tool: "mini.notes.*" }] } }, reply: () => ({ content: [{ type: "text", text: "y".repeat(500) }] }) });
    expect((await callTool(people, "mini__notes__search_notes", { query: "x".repeat(200) }, w.deps)).content[0].text).toMatch(/arguments too large/);
    expect(w.pushed).toHaveLength(0);
    expect((await callTool(people, "mini__notes__search_notes", { query: "x" }, w.deps)).content[0].text).toMatch(/result too large/);
    expect(w.audit.map((a) => a.outcome)).toEqual(["too_large", "too_large"]);
  });

  it("fails fast with a clear error when the machine is offline", async () => {
    const w = world({ agents: { people: { rules: [{ tool: "mini.notes.*" }] } }, machines: [mini({ connectionId: undefined, lastSeenAt: T0 - 7_200_000 })] });
    const out = await callTool(people, "mini__notes__search_notes", {}, w.deps);
    expect(out.content[0].text).toMatch(/mini is offline \(last seen/);
    expect(w.audit[0]).toMatchObject({ outcome: "offline" });
  });

  it("returns no data when the audit write fails", async () => {
    const w = world({ agents: { people: { rules: [{ tool: "mini.notes.*" }] } }, auditFails: true, reply: () => ({ content: [{ type: "text", text: "secret" }] }) });
    const out = await callTool(people, "mini__notes__search_notes", {}, w.deps);
    expect(out.isError).toBe(true);
    expect(JSON.stringify(out)).not.toContain("secret");
  });

  it("bridge_health reports machines, servers and how many tools the caller may use", async () => {
    const w = world({ agents: { people: { rules: [{ tool: "mini.notes.*" }] } } });
    const out = await callTool(people, "bridge_health", {}, w.deps);
    const body = out.structuredContent as { machines: Array<{ machine: string; connected: boolean; servers: Array<{ server: string; toolsAvailableToYou: number }> }> };
    expect(body.machines[0]).toMatchObject({ machine: "mini", connected: true });
    expect(body.machines[0].servers).toEqual([
      { server: "notes", status: "up", toolsAvailableToYou: 2 },
      { server: "messages", status: "up", toolsAvailableToYou: 0 },
    ]);
  });
});
