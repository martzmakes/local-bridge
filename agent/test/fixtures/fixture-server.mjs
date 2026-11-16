#!/usr/bin/env node
// A tiny stdio MCP server for the agent's tests. No Apple apps, no network.
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

const obj = (properties = {}) => ({ type: "object", properties });
const TOOLS = [
  { name: "echo", description: "Returns its text argument", inputSchema: obj({ text: { type: "string" } }) },
  { name: "big", description: "Returns `bytes` bytes of text", inputSchema: obj({ bytes: { type: "number" } }) },
  { name: "slow", description: "Answers after `ms` milliseconds", inputSchema: obj({ ms: { type: "number" } }) },
  { name: "crash", description: "Kills the server process", inputSchema: obj() },
  { name: "boom", description: "Throws an error that quotes its argument", inputSchema: obj({ text: { type: "string" } }) },
  { name: "automation_denied", description: "Fails like osascript without Automation permission", inputSchema: obj() },
  { name: "automation_thrown", description: "Throws the same failure as a protocol error", inputSchema: obj() },
  { name: "disk_denied", description: "Fails like sqlite without Full Disk Access", inputSchema: obj() },
  { name: "write_thing", description: "Pretends to change something", inputSchema: obj({ text: { type: "string" } }) },
  { name: "hidden", description: "Never exposed by a test config", inputSchema: obj() },
];

// `--inspect-tools` adds tools whose names and annotations exercise `inspect`'s suggestions.
if (process.argv.includes("--inspect-tools")) {
  TOOLS.push(
    { name: "get_thing", description: "Read by name only", inputSchema: obj() },
    { name: "List_Things", description: "Read by name, whatever the case", inputSchema: obj() },
    { name: "peek", description: "Read by annotation only", inputSchema: obj(), annotations: { readOnlyHint: true } },
    { name: "search_and_destroy", description: "Named like a read, marked destructive", inputSchema: obj(), annotations: { destructiveHint: true } },
    { name: "find_and_fix", description: "Named like a read, marked not read-only", inputSchema: obj(), annotations: { readOnlyHint: false } },
    { name: "wipe", description: "Read-only and destructive at once", inputSchema: obj(), annotations: { readOnlyHint: true, destructiveHint: true } },
    { name: "getter", inputSchema: obj() },
  );
}
// `--hang` never answers anything, like a server stuck starting up.
if (process.argv.includes("--hang")) {
  setInterval(() => {}, 1000);
  await new Promise(() => {});
}

const text = (t, isError = false) => ({ content: [{ type: "text", text: t }], ...(isError ? { isError: true } : {}) });
// unref: a pending sleep must not keep the process alive once stdin closes.
const sleep = (ms) => new Promise((r) => setTimeout(r, ms).unref());

const server = new Server({ name: "fixture", version: "0.0.0" }, { capabilities: { tools: {} } });
// Paged, so clients have to follow nextCursor to see everything.
const PAGE = 8;
server.setRequestHandler(ListToolsRequestSchema, async (req) => {
  const start = Number(req.params?.cursor ?? 0);
  const next = start + PAGE;
  return { tools: TOOLS.slice(start, next), ...(next < TOOLS.length ? { nextCursor: String(next) } : {}) };
});
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const args = req.params.arguments ?? {};
  switch (req.params.name) {
    case "echo":
      return text(String(args.text ?? ""));
    case "big":
      return text("x".repeat(Number(args.bytes ?? 0)));
    case "slow":
      await sleep(Number(args.ms ?? 0));
      return text("done");
    case "crash":
      process.exit(1);
    // eslint-disable-next-line no-fallthrough
    case "boom":
      throw new Error(`could not process ${String(args.text)}`);
    case "automation_denied":
      return text("execution error: Not authorized to send Apple events to Notes. (-1743)", true);
    case "automation_thrown":
      throw new Error("osascript failed: execution error: Not authorized to send Apple events to Contacts. (-1743)");
    case "disk_denied":
      return text("SqliteError: authorization denied (chat.db)", true);
    case "write_thing":
      return text("written");
    case "hidden":
      return text("you should never see this");
    default:
      throw new Error(`unknown tool ${req.params.name}`);
  }
});

await server.connect(new StdioServerTransport());
