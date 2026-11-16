// Authorization policy: pure functions, no I/O.
// Spec section 8. Default deny; a write tool needs an exact rule with
// access "write"; a wildcard never grants a write tool; filters fail closed.
import { z } from "zod";
import type { Access, ToolResult } from "../../shared/protocol";
import { canonicalId, wildcardFor, type ToolRef } from "./names";

const ConstraintSchema = z
  .object({
    enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
    pattern: z.string().max(500).optional(),
    maxLength: z.number().int().nonnegative().optional(),
    min: z.number().optional(),
    max: z.number().optional(),
  })
  .strict();

export const RuleSchema = z
  .object({
    tool: z.string().min(5).max(200),
    access: z.enum(["read", "write"]),
    args: z
      .object({
        force: z.record(z.string(), z.unknown()).optional(),
        deny: z.array(z.string()).optional(),
        constraints: z.record(z.string(), ConstraintSchema).optional(),
      })
      .strict()
      .optional(),
    result: z
      .object({
        maxBytes: z.number().int().positive().optional(),
        redact: z
          .array(z.object({ pattern: z.string().max(500), replacement: z.string().max(100).optional() }).strict())
          .max(20)
          .optional(),
        items: z
          .object({
            /** Dot path to the array inside the parsed JSON; "" means the root is the array. */
            path: z.string().max(200),
            field: z.string().min(1).max(200),
            allow: z.string().max(500).optional(),
            deny: z.string().max(500).optional(),
          })
          .strict()
          .optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .superRefine((rule, ctx) => {
    if (rule.access === "write" && rule.tool.endsWith(".*")) {
      ctx.addIssue({ code: "custom", message: "a write rule must name the tool exactly, not a wildcard" });
    }
    for (const p of [rule.result?.items?.allow, rule.result?.items?.deny, ...(rule.result?.redact ?? []).map((r) => r.pattern), ...Object.values(rule.args?.constraints ?? {}).map((c) => c.pattern)]) {
      if (p === undefined) continue;
      try {
        new RegExp(p);
      } catch {
        ctx.addIssue({ code: "custom", message: `invalid regular expression: ${p}` });
      }
    }
  });
export type Rule = z.infer<typeof RuleSchema>;

export type Decision =
  | { allowed: true; rule: Rule }
  | { allowed: false; reason: DenyReason };

export type DenyReason =
  | "agent_unknown"
  | "agent_disabled"
  | "no_rule"
  | "write_not_enabled"
  | "arg_denied"
  | "arg_constraint";

/**
 * Decides whether `rules` (all rules of one enabled agent) allow `ref`.
 * `toolAccess` is the class the machine reported for the tool.
 */
export function decide(rules: Rule[], ref: ToolRef, toolAccess: Access): Decision {
  const id = canonicalId(ref);
  const exact = rules.find((r) => r.tool === id);
  const wild = rules.find((r) => r.tool === wildcardFor(ref));
  if (toolAccess === "write") {
    // Only an exact write rule will do. An exact read rule on a write tool is a
    // misconfiguration and must not allow the call.
    if (exact && exact.access === "write") return { allowed: true, rule: exact };
    return { allowed: false, reason: exact || wild ? "write_not_enabled" : "no_rule" };
  }
  const rule = exact ?? wild;
  if (!rule) return { allowed: false, reason: "no_rule" };
  return { allowed: true, rule };
}

export class PolicyError extends Error {
  constructor(public reason: DenyReason | "result_unfilterable" | "result_too_large", message: string) {
    super(message);
  }
}

/** Applies deny, constraints, then force. Returns the arguments to send. Messages never echo values. */
export function applyArgPolicy(rule: Rule, args: Record<string, unknown>): Record<string, unknown> {
  const policy = rule.args;
  if (!policy) return args;
  for (const name of policy.deny ?? []) {
    if (name in args) throw new PolicyError("arg_denied", `argument "${name}" is not permitted for this agent`);
  }
  for (const [name, c] of Object.entries(policy.constraints ?? {})) {
    if (!(name in args) || args[name] === undefined) continue;
    const v = args[name];
    const fail = (why: string): never => {
      throw new PolicyError("arg_constraint", `argument "${name}" ${why}`);
    };
    if (c.enum && !c.enum.includes(v as never)) fail("is not one of the permitted values");
    if (c.pattern !== undefined) {
      if (typeof v !== "string" || !new RegExp(c.pattern).test(v)) fail("does not match the permitted pattern");
    }
    if (c.maxLength !== undefined) {
      if (typeof v !== "string" || v.length > c.maxLength) fail(`must be a string of at most ${c.maxLength} characters`);
    }
    if (c.min !== undefined) {
      if (typeof v !== "number" || v < c.min) fail(`must be a number of at least ${c.min}`);
    }
    if (c.max !== undefined) {
      if (typeof v !== "number" || v > c.max) fail(`must be a number of at most ${c.max}`);
    }
  }
  return { ...args, ...(policy.force ?? {}) };
}

function getPath(root: unknown, path: string): unknown {
  if (path === "") return root;
  let cur: unknown = root;
  for (const part of path.split(".")) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function setPath(root: unknown, path: string, value: unknown): unknown {
  if (path === "") return value;
  const parts = path.split(".");
  let cur = root as Record<string, unknown>;
  for (const part of parts.slice(0, -1)) cur = cur[part] as Record<string, unknown>;
  cur[parts[parts.length - 1]] = value;
  return root;
}

function filterItems(root: unknown, items: NonNullable<NonNullable<Rule["result"]>["items"]>): unknown {
  const arr = getPath(root, items.path);
  if (!Array.isArray(arr)) throw new PolicyError("result_unfilterable", "result could not be filtered for this agent");
  const allow = items.allow !== undefined ? new RegExp(items.allow) : null;
  const deny = items.deny !== undefined ? new RegExp(items.deny) : null;
  const kept = arr.filter((item) => {
    const raw = getPath(item, items.field);
    // An item without the field cannot be shown to be permitted: drop it.
    if (raw === undefined || raw === null) return false;
    const s = String(raw);
    if (deny && deny.test(s)) return false;
    if (allow && !allow.test(s)) return false;
    return true;
  });
  return setPath(root, items.path, kept);
}

export function resultBytes(result: ToolResult): number {
  return Buffer.byteLength(JSON.stringify(result), "utf8");
}

/**
 * Applies the rule's result filters and the size limit. Throws PolicyError
 * rather than returning anything it could not filter.
 */
export function applyResultPolicy(rule: Rule, result: ToolResult, agentMaxBytes: number): ToolResult {
  const policy = rule.result;
  let out: ToolResult = result;
  if (policy?.items || policy?.redact?.length) {
    const redactions = (policy.redact ?? []).map((r) => ({ re: new RegExp(r.pattern, "g"), to: r.replacement ?? "[redacted]" }));
    const content = result.content.map((block) => {
      if (block.type !== "text" || typeof block.text !== "string") {
        // Images, audio, embedded resources: nothing here can filter them.
        if (policy.items) throw new PolicyError("result_unfilterable", "result could not be filtered for this agent");
        return block;
      }
      let text = block.text;
      if (policy.items) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(text);
        } catch {
          throw new PolicyError("result_unfilterable", "result could not be filtered for this agent");
        }
        text = JSON.stringify(filterItems(parsed, policy.items));
      }
      for (const r of redactions) text = text.replace(r.re, r.to);
      return { ...block, text };
    });
    out = { ...result, content };
    if (result.structuredContent !== undefined) {
      if (policy.items) {
        // The structured copy must be filtered the same way, or dropped.
        let structured: Record<string, unknown> | undefined;
        try {
          structured = filterItems(JSON.parse(JSON.stringify(result.structuredContent)), policy.items) as Record<string, unknown>;
        } catch {
          structured = undefined;
        }
        out = { ...out, structuredContent: structured };
      }
      if (redactions.length && out.structuredContent !== undefined) {
        let s = JSON.stringify(out.structuredContent);
        for (const r of redactions) s = s.replace(r.re, r.to);
        try {
          out = { ...out, structuredContent: JSON.parse(s) as Record<string, unknown> };
        } catch {
          out = { ...out, structuredContent: undefined };
        }
      }
      if (out.structuredContent === undefined) delete (out as Record<string, unknown>).structuredContent;
    }
  }
  const limit = Math.min(agentMaxBytes, policy?.maxBytes ?? agentMaxBytes);
  const size = resultBytes(out);
  if (size > limit) {
    throw new PolicyError("result_too_large", `result too large (${size} bytes, limit ${limit}). Narrow the request.`);
  }
  return out;
}
