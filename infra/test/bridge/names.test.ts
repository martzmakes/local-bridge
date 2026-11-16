import { canonicalId, parseCanonical, wireName, wildcardFor, isValidAgentId } from "../../lib/lambdas/bridge/names";

describe("tool names", () => {
  const ref = { machine: "mini", server: "messages", tool: "search_messages" };

  it("uses dots for the canonical id and double underscores on the wire", () => {
    expect(canonicalId(ref)).toBe("mini.messages.search_messages");
    expect(wireName(ref)).toBe("mini__messages__search_messages");
    expect(wildcardFor(ref)).toBe("mini.messages.*");
  });

  it("keeps wire names inside the [a-zA-Z0-9_-]{1,64} limit hosts enforce", () => {
    const long = wireName({ machine: "mini", server: "ha", tool: "a".repeat(120) });
    expect(long).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
    const dotted = wireName({ machine: "mini", server: "ha", tool: "light.turn_on" });
    expect(dotted).toMatch(/^[a-zA-Z0-9_-]{1,64}$/);
  });

  it("never gives two different tools the same wire name", () => {
    const a = wireName({ machine: "mini", server: "ha", tool: "light.turn_on" });
    const b = wireName({ machine: "mini", server: "ha", tool: "light_turn_on" });
    expect(a).not.toBe(b);
    const base = "b".repeat(100);
    expect(wireName({ machine: "mini", server: "ha", tool: base + "1" })).not.toBe(wireName({ machine: "mini", server: "ha", tool: base + "2" }));
  });

  it("parses canonical ids, including wildcards and tools containing dots", () => {
    expect(parseCanonical("mini.notes.search_notes")).toEqual({ machine: "mini", server: "notes", tool: "search_notes" });
    expect(parseCanonical("mini.notes.*")).toEqual({ machine: "mini", server: "notes", tool: "*" });
    expect(parseCanonical("mini.ha.light.turn_on")?.tool).toBe("light.turn_on");
    expect(parseCanonical("mini.notes")).toBeNull();
    expect(parseCanonical("Mini.notes.x")).toBeNull();
    expect(parseCanonical("mini..x")).toBeNull();
  });

  it("validates agent ids", () => {
    expect(isValidAgentId("people")).toBe(true);
    expect(isValidAgentId("night-swarm")).toBe(true);
    expect(isValidAgentId("People")).toBe(false);
    expect(isValidAgentId("a#b")).toBe(false);
    expect(isValidAgentId("")).toBe(false);
  });
});
