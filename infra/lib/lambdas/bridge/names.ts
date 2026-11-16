// Tool naming. Canonical ids are dotted (mini.notes.search_notes) and are what
// rules, audit rows and health output use. Wire names are what MCP clients see;
// Anthropic and OpenAI restrict those to [a-zA-Z0-9_-]{1,64}, so dots become
// double underscores. The cloud never parses a wire name: it builds a lookup
// from the catalog, so a local tool containing "__" is not ambiguous.
import { createHash } from "crypto";
import { NAME_RE } from "../../shared/protocol";

export const WIRE_MAX = 64;
const WIRE_SAFE = /^[a-zA-Z0-9_-]+$/;

export interface ToolRef {
  machine: string;
  server: string;
  tool: string;
}

export function canonicalId(ref: ToolRef): string {
  return `${ref.machine}.${ref.server}.${ref.tool}`;
}

export function isValidName(name: string): boolean {
  return NAME_RE.test(name);
}

/** Agent ids share the machine/server alphabet, plus hyphens, up to 32 chars. */
export function isValidAgentId(id: string): boolean {
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(id);
}

export function wireName(ref: ToolRef): string {
  const safeTool = ref.tool.replace(/[^a-zA-Z0-9_-]/g, "_");
  const full = `${ref.machine}__${ref.server}__${safeTool}`;
  if (full.length <= WIRE_MAX && WIRE_SAFE.test(full) && safeTool === ref.tool) return full;
  // Too long, or the tool name had characters we replaced: add a short hash of
  // the canonical id so two different tools can never share a wire name.
  const hash = createHash("sha256").update(canonicalId(ref)).digest("hex").slice(0, 8);
  return `${full.slice(0, WIRE_MAX - 9)}_${hash}`;
}

/** Parses "mini.notes.search_notes" or "mini.notes.*". The tool part may contain dots. */
export function parseCanonical(id: string): ToolRef | null {
  const first = id.indexOf(".");
  const second = id.indexOf(".", first + 1);
  if (first <= 0 || second <= first + 1 || second === id.length - 1) return null;
  const machine = id.slice(0, first);
  const server = id.slice(first + 1, second);
  const tool = id.slice(second + 1);
  if (!isValidName(machine) || !isValidName(server)) return null;
  return { machine, server, tool };
}

export function wildcardFor(ref: ToolRef): string {
  return `${ref.machine}.${ref.server}.*`;
}
