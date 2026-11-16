import { dispatchCall, GoneError, livenessFailure, type DispatchDeps } from "../../lib/lambdas/bridge/dispatch";
import type { CallMeta, MachineMeta } from "../../lib/lambdas/bridge/store";
import type { CloudMessage } from "../../lib/shared/protocol";

const T0 = Date.UTC(2026, 10, 15, 18, 0, 0);
const live: MachineMeta = { id: "mini", enabled: true, keys: [], connectionId: "conn1", lastSeenAt: T0 - 10_000 };
const req = { callId: "c1", agent: "people", machine: "mini", server: "notes", tool: "search_notes", args: { query: "q" }, timeoutMs: 20_000, maxResultBytes: 1000 };

/** A fake cloud where time only moves when dispatch sleeps. `machine` scripts what the device does and when. */
function harness(meta: MachineMeta | null, machine: (elapsed: number, call: CallMeta) => void = () => {}, push?: DispatchDeps["push"]) {
  let now = T0;
  const calls = new Map<string, CallMeta>();
  const pushed: CloudMessage[] = [];
  const results = new Map<string, string>();
  const deps: DispatchDeps = {
    getMachine: async () => meta,
    createCall: async (callId, m, agent) => void calls.set(callId, { callId, machine: m, agent, status: "pending", createdAt: now }),
    getCall: async (id) => {
      const c = calls.get(id);
      if (c && (c.status === "pending" || c.status === "acked")) machine(now - T0, c);
      return c ? { ...c } : null;
    },
    readResult: async (id) => results.get(id) ?? "",
    abandonCall: async (id) => void (calls.get(id)!.status = "abandoned"),
    deleteCall: async (id) => void calls.delete(id),
    push: push ?? (async (_c, m) => void pushed.push(m)),
    now: () => now,
    sleep: async (ms) => void (now += ms),
  };
  return { deps, calls, pushed, results, elapsed: () => now - T0 };
}

describe("liveness", () => {
  it("fails immediately for unregistered, disabled, disconnected and stale machines", () => {
    expect(livenessFailure(null, "mini", T0)).toMatchObject({ failure: "not_registered" });
    expect(livenessFailure({ ...live, enabled: false }, "mini", T0)).toMatchObject({ failure: "machine_disabled" });
    expect(livenessFailure({ ...live, connectionId: undefined, lastSeenAt: T0 - 3_600_000 }, "mini", T0)).toMatchObject({ failure: "offline" });
    expect(livenessFailure({ ...live, lastSeenAt: T0 - 151_000 }, "mini", T0)).toMatchObject({ failure: "offline" });
    expect(livenessFailure(live, "mini", T0)).toBeNull();
  });

  it("says reconnecting when the machine dropped its socket seconds ago", () => {
    expect(livenessFailure({ ...live, connectionId: undefined, lastSeenAt: T0 - 5_000 }, "mini", T0)).toMatchObject({ failure: "reconnecting" });
  });

  it("tells the caller when the machine was last seen, in Eastern time", () => {
    const r = livenessFailure({ ...live, connectionId: undefined, lastSeenAt: Date.UTC(2026, 10, 15, 19, 2, 0) }, "mini", T0 + 86_400_000);
    expect(r && !r.ok && r.message).toContain("2:02 PM ET");
  });
});

describe("dispatchCall", () => {
  it("does not send anything to a machine that is offline", async () => {
    const h = harness({ ...live, connectionId: undefined, lastSeenAt: T0 - 3_600_000 });
    const out = await dispatchCall(req, h.deps);
    expect(out).toMatchObject({ ok: false, failure: "offline" });
    expect(h.pushed).toHaveLength(0);
    expect(h.elapsed()).toBe(0);
  });

  it("fails at once when the connection is gone", async () => {
    const h = harness(live, undefined, async () => {
      throw new GoneError();
    });
    const out = await dispatchCall(req, h.deps);
    expect(out).toMatchObject({ ok: false, failure: "offline" });
    expect(h.elapsed()).toBe(0);
    expect(h.calls.size).toBe(0);
  });

  it("sends the call with a deadline and returns the machine's result", async () => {
    const h = harness(live, (elapsed, call) => {
      if (elapsed >= 40) call.status = "acked";
      if (elapsed >= 200) {
        call.status = "done";
        call.chunks = 1;
        h.results.set("c1", JSON.stringify({ content: [{ type: "text", text: "found" }] }));
      }
    });
    const out = await dispatchCall(req, h.deps);
    expect(out).toEqual({ ok: true, result: { content: [{ type: "text", text: "found" }] } });
    expect(h.pushed[0]).toMatchObject({ type: "call", callId: "c1", server: "notes", tool: "search_notes", arguments: { query: "q" }, deadline: T0 + 20_000, maxResultBytes: 1000 });
    expect(h.calls.size).toBe(0); // result rows are deleted as soon as they are read
  });

  it("gives up at 3 seconds when the machine never acks, and marks the call so a late result is dropped", async () => {
    const h = harness(live);
    const out = await dispatchCall(req, h.deps);
    expect(out).toMatchObject({ ok: false, failure: "not_responding" });
    expect(h.elapsed()).toBeGreaterThanOrEqual(3000);
    expect(h.elapsed()).toBeLessThan(3300);
    expect(h.calls.get("c1")?.status).toBe("abandoned");
  });

  it("times out at the deadline, cancels on the machine, and warns that a write may have happened", async () => {
    const h = harness(live, (_e, call) => void (call.status = "acked"));
    const out = await dispatchCall(req, h.deps);
    expect(out).toMatchObject({ ok: false, failure: "timeout" });
    expect(!out.ok && out.message).toMatch(/may still have happened/);
    expect(h.elapsed()).toBeGreaterThanOrEqual(20_000);
    expect(h.elapsed()).toBeLessThan(20_300);
    expect(h.pushed.at(-1)).toEqual({ type: "cancel", callId: "c1" });
    expect(h.calls.get("c1")?.status).toBe("abandoned");
  });

  it("replaces free-text machine errors with fixed wording, so server text cannot reach the caller or the logs", async () => {
    const h = harness(live, (_e, call) => {
      call.status = "error";
      call.error = { code: "tool_error", message: "AppleScript failed near: Dear Mom, the diagnosis is" };
    });
    const out = await dispatchCall(req, h.deps);
    expect(out).toMatchObject({ ok: false, failure: "machine_error", machineCode: "tool_error" });
    expect(!out.ok && out.message).not.toContain("diagnosis");
  });

  it("passes through the machine's permission and size messages", async () => {
    const h = harness(live, (_e, call) => {
      call.status = "error";
      call.error = { code: "permission", message: "Automation permission not granted for Notes" };
    });
    const out = await dispatchCall(req, h.deps);
    expect(!out.ok && out.message).toBe("mini.notes: Automation permission not granted for Notes");
  });
});
