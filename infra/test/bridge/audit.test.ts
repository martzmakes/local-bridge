import { argsHash, buildAuditRow, canonicalJson } from "../../lib/lambdas/bridge/audit";

describe("audit", () => {
  it("hashes equal arguments equally regardless of key order", () => {
    expect(argsHash({ a: 1, b: { c: [1, 2], d: "x" } }, "k")).toBe(argsHash({ b: { d: "x", c: [1, 2] }, a: 1 }, "k"));
    expect(canonicalJson({ b: 1, a: undefined, c: null })).toBe('{"b":1,"c":null}');
  });

  it("gives a different hash under a different key, so hashes cannot be guessed offline", () => {
    expect(argsHash({ query: "Mom" }, "key-one")).not.toBe(argsHash({ query: "Mom" }, "key-two"));
  });

  it("builds a row with a retention TTL and no argument or result content", () => {
    const ts = Date.UTC(2026, 10, 15, 12, 0, 0);
    const row = buildAuditRow(
      { ts, callId: "c1", agent: "people", tool: "mini.messages.search_messages", machine: "mini", outcome: "ok", argsHash: argsHash({ query: "Mom birthday" }, "k"), argBytes: 24, resultBytes: 512, latencyMs: 80, tokenKind: "oauth" },
      90
    );
    expect(row.pk).toBe("AUDIT#2026-11-15");
    expect(row.sk).toBe("2026-11-15T12:00:00.000Z#c1");
    expect(row.ttl).toBe(Math.floor(ts / 1000) + 90 * 86_400);
    expect(JSON.stringify(row)).not.toContain("Mom");
    expect(Object.keys(row).sort()).toEqual(["agent", "argBytes", "argsHash", "callId", "latencyMs", "machine", "outcome", "pk", "resultBytes", "sk", "tokenKind", "tool", "ts", "ttl"]);
  });
});
