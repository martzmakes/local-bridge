// The macOS privacy permissions each known local server needs (spec section 10).
import type { ServerConfig } from "./config";

export interface PermissionRow {
  server: string;
  kind: string;
  permission: string;
  why: string;
}

interface Known {
  kind: string;
  match: RegExp;
  permission: string;
  why: string;
}

const KNOWN: Known[] = [
  {
    kind: "apple-notes-mcp",
    match: /apple-notes-mcp/,
    permission: "Automation: node to control Notes",
    why: "Reads and writes notes by AppleScript through osascript. No disk access needed.",
  },
  {
    kind: "imessage-mcp",
    match: /imessage-mcp/,
    permission: "Full Disk Access; Automation: Contacts (and Messages if sending is ever enabled)",
    why: "Reads ~/Library/Messages/chat.db and the AddressBook databases; contact lookups use osascript.",
  },
  {
    kind: "apple-reminders-mcp",
    match: /apple-reminders-mcp/,
    permission: "Reminders (full access)",
    why: "Its Swift helper uses EventKit. A missing grant exits 0 and looks like \"no reminders\".",
  },
  {
    kind: "Home Assistant",
    match: /mcp_server|:8123\b|homeassistant/i,
    permission: "None (Local Network if HA is not on this machine)",
    why: "HTTP to Home Assistant with a long-lived token kept in the Keychain.",
  },
];

export const AGENT_PERMISSION: Omit<PermissionRow, "server"> = {
  kind: "the agent itself",
  permission: "Keychain item access",
  why: "Reads its device key and any keychain: values through /usr/bin/security.",
};

function describe(config: ServerConfig): string {
  return config.transport === "stdio" ? [config.command, ...config.args].join(" ") : config.url;
}

export function kindOf(config: ServerConfig): string | undefined {
  const text = describe(config);
  return KNOWN.find((k) => k.match.test(text))?.kind;
}

export function permissionRows(servers: Record<string, ServerConfig>): PermissionRow[] {
  const rows: PermissionRow[] = Object.entries(servers).map(([server, config]) => {
    const known = KNOWN.find((k) => k.match.test(describe(config)));
    return known
      ? { server, kind: known.kind, permission: known.permission, why: known.why }
      : { server, kind: "unknown server", permission: "Not known", why: "Check what the server reads and which apps it drives." };
  });
  rows.push({ server: "(agent)", ...AGENT_PERMISSION });
  return rows;
}

export function formatTable(rows: PermissionRow[]): string {
  const header = ["Server", "Kind", "Permission", "Why"];
  const data = rows.map((r) => [r.server, r.kind, r.permission, r.why]);
  const widths = header.map((h, i) => Math.max(h.length, ...data.map((d) => (d[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : c.padEnd(widths[i] ?? 0))).join("  ");
  return [line(header), line(widths.map((w) => "-".repeat(w))), ...data.map(line)].join("\n");
}
