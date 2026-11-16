import { applyArgPolicy, applyResultPolicy, decide, PolicyError, RuleSchema, type Rule } from "../../lib/lambdas/bridge/policy";

const search = { machine: "mini", server: "notes", tool: "search_notes" };
const create = { machine: "mini", server: "notes", tool: "create_note" };
const rule = (r: Partial<Rule> & { tool: string }): Rule => RuleSchema.parse({ access: "read", ...r });

describe("decide", () => {
  it("denies by default", () => {
    expect(decide([], search, "read")).toEqual({ allowed: false, reason: "no_rule" });
  });

  it("allows a read tool by exact rule or by server wildcard", () => {
    expect(decide([rule({ tool: "mini.notes.search_notes" })], search, "read").allowed).toBe(true);
    expect(decide([rule({ tool: "mini.notes.*" })], search, "read").allowed).toBe(true);
  });

  it("does not let a rule for another server or machine apply", () => {
    expect(decide([rule({ tool: "mini.messages.*" })], search, "read").allowed).toBe(false);
    expect(decide([rule({ tool: "air.notes.*" })], search, "read").allowed).toBe(false);
  });

  it("never grants a write tool through a wildcard", () => {
    expect(decide([rule({ tool: "mini.notes.*" })], create, "write")).toEqual({ allowed: false, reason: "write_not_enabled" });
  });

  it("never grants a write tool through an exact read rule", () => {
    expect(decide([rule({ tool: "mini.notes.create_note" })], create, "write")).toEqual({ allowed: false, reason: "write_not_enabled" });
  });

  it("grants a write tool only through an exact write rule", () => {
    expect(decide([rule({ tool: "mini.notes.create_note", access: "write" })], create, "write").allowed).toBe(true);
  });

  it("prefers the exact rule over the wildcard", () => {
    const d = decide([rule({ tool: "mini.notes.*" }), rule({ tool: "mini.notes.search_notes", args: { force: { folder: "Fitness" } } })], search, "read");
    expect(d.allowed && d.rule.args?.force).toEqual({ folder: "Fitness" });
  });

  it("refuses to define a wildcard write rule at all", () => {
    expect(RuleSchema.safeParse({ tool: "mini.notes.*", access: "write" }).success).toBe(false);
  });
});

describe("argument policy", () => {
  const r = rule({
    tool: "mini.notes.search_notes",
    args: { force: { folder: "Fitness" }, deny: ["account"], constraints: { limit: { max: 25 }, query: { maxLength: 10 }, kind: { enum: ["a", "b"] } } },
  });

  it("forces arguments over whatever the agent sent", () => {
    expect(applyArgPolicy(r, { query: "squat", folder: "Private" })).toEqual({ query: "squat", folder: "Fitness" });
  });

  it("rejects denied arguments and constraint violations", () => {
    expect(() => applyArgPolicy(r, { account: "iCloud" })).toThrow(PolicyError);
    expect(() => applyArgPolicy(r, { limit: 100 })).toThrow(/limit/);
    expect(() => applyArgPolicy(r, { limit: "100" })).toThrow(PolicyError);
    expect(() => applyArgPolicy(r, { query: "a much longer query" })).toThrow(PolicyError);
    expect(() => applyArgPolicy(r, { kind: "c" })).toThrow(PolicyError);
  });

  it("does not echo the offending value in the error", () => {
    try {
      applyArgPolicy(r, { query: "secret-contact-name" });
      throw new Error("should have thrown");
    } catch (e) {
      expect((e as Error).message).not.toContain("secret-contact-name");
    }
  });
});

describe("result policy", () => {
  const json = (v: unknown) => ({ content: [{ type: "text", text: JSON.stringify(v) }] });
  const messages = { messages: [{ sender: "Mom", text: "hi" }, { sender: "Stranger", text: "ssn 123-45-6789" }, { text: "no sender" }] };

  it("keeps only items whose field matches the allow pattern, dropping items without the field", () => {
    const r = rule({ tool: "mini.messages.search_messages", result: { items: { path: "messages", field: "sender", allow: "^(Mom|Whit)$" } } });
    const out = applyResultPolicy(r, json(messages), 100_000);
    expect(JSON.parse(out.content[0].text as string)).toEqual({ messages: [{ sender: "Mom", text: "hi" }] });
  });

  it("drops items matching the deny pattern", () => {
    const r = rule({ tool: "mini.messages.search_messages", result: { items: { path: "messages", field: "sender", deny: "Stranger" } } });
    const out = JSON.parse(applyResultPolicy(r, json(messages), 100_000).content[0].text as string);
    expect(out.messages.map((m: { sender: string }) => m.sender)).toEqual(["Mom"]);
  });

  it("filters a root-level array with an empty path", () => {
    const r = rule({ tool: "mini.messages.search_messages", result: { items: { path: "", field: "sender", allow: "Mom" } } });
    expect(JSON.parse(applyResultPolicy(r, json(messages.messages), 100_000).content[0].text as string)).toHaveLength(1);
  });

  it("fails closed when an items filter cannot be applied", () => {
    const r = rule({ tool: "mini.messages.search_messages", result: { items: { path: "messages", field: "sender", allow: "Mom" } } });
    expect(() => applyResultPolicy(r, { content: [{ type: "text", text: "Mom: hi\nStranger: hello" }] }, 100_000)).toThrow(/could not be filtered/);
    expect(() => applyResultPolicy(r, json({ other: [] }), 100_000)).toThrow(/could not be filtered/);
    expect(() => applyResultPolicy(r, { content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] }, 100_000)).toThrow(/could not be filtered/);
  });

  it("filters or drops structuredContent so the unfiltered copy cannot leak", () => {
    const r = rule({ tool: "mini.messages.search_messages", result: { items: { path: "messages", field: "sender", allow: "Mom" } } });
    const out = applyResultPolicy(r, { ...json(messages), structuredContent: messages }, 100_000);
    expect(JSON.stringify(out)).not.toContain("Stranger");
    const mismatched = applyResultPolicy(r, { ...json(messages), structuredContent: { different: "shape", leak: "Stranger" } }, 100_000);
    expect(JSON.stringify(mismatched)).not.toContain("Stranger");
  });

  it("redacts patterns in text and structured content", () => {
    const r = rule({ tool: "mini.messages.search_messages", result: { redact: [{ pattern: "\\b\\d{3}-\\d{2}-\\d{4}\\b" }] } });
    const out = applyResultPolicy(r, { ...json(messages), structuredContent: messages }, 100_000);
    expect(JSON.stringify(out)).not.toContain("123-45-6789");
    expect(JSON.stringify(out)).toContain("[redacted]");
  });

  it("enforces the smaller of the agent limit and the rule limit", () => {
    const big = { content: [{ type: "text", text: "x".repeat(5000) }] };
    expect(() => applyResultPolicy(rule({ tool: "mini.notes.get_note" }), big, 1000)).toThrow(/too large/);
    expect(() => applyResultPolicy(rule({ tool: "mini.notes.get_note", result: { maxBytes: 1000 } }), big, 100_000)).toThrow(/too large/);
    expect(applyResultPolicy(rule({ tool: "mini.notes.get_note" }), big, 100_000)).toBe(big);
  });
});
