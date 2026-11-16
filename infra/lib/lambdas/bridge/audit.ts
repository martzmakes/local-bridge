// Audit rows. Spec section 8.3: agent, tool, arguments hash, sizes, outcome.
// Nothing in here may carry argument values, result content, or error text
// produced by a local server.
import { createHmac } from "crypto";

/** JSON with object keys sorted at every level, so equal arguments hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

/** Keyed hash: without the key, a short argument cannot be recovered by guessing. */
export function argsHash(args: unknown, hmacKey: string): string {
  return createHmac("sha256", hmacKey).update(canonicalJson(args)).digest("hex");
}

export type Outcome =
  | "ok"
  | "tool_error" // the local tool returned isError or threw
  | "denied"
  | "rate_limited"
  | "too_large"
  | "offline"
  | "timeout"
  | "filtered_out" // result could not be filtered, so it was withheld
  | "bridge_error";

export interface AuditInput {
  ts: number;
  callId: string;
  agent: string;
  tool: string; // canonical id, or the wire name if it did not resolve
  machine?: string;
  outcome: Outcome;
  reason?: string; // a fixed code from this codebase, never free text from a server
  argsHash: string;
  argBytes: number;
  resultBytes: number;
  latencyMs: number;
  tokenKind: "oauth" | "minted";
}

export interface AuditRow extends AuditInput {
  pk: string;
  sk: string;
  ttl: number;
}

export function buildAuditRow(input: AuditInput, retentionDays: number): AuditRow {
  const day = new Date(input.ts).toISOString().slice(0, 10);
  return {
    pk: `AUDIT#${day}`,
    sk: `${new Date(input.ts).toISOString()}#${input.callId}`,
    ttl: Math.floor(input.ts / 1000) + retentionDays * 86_400,
    ...input,
  };
}
