import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { callFromText, callOnce } from "../src/call";
import { inspectServer } from "../src/inspect";
import { fakeSecurity } from "./helpers";

const fixture = fileURLToPath(new URL("./fixtures/fixture-server.mjs", import.meta.url));
const server = { transport: "stdio", command: process.execPath, args: [fixture] };
const opts = () => ({ keychain: fakeSecurity().keychain });

describe("call (Try a tool)", () => {
  it("runs one tool once and returns its result with a duration", async () => {
    const r = await callOnce({ server, tool: "echo", arguments: { text: "hello" } }, opts());
    expect(r.ok && r.result).toEqual({ content: [{ type: "text", text: "hello" }], isError: false });
    expect(r.ok && r.ms).toBeGreaterThanOrEqual(0);
  });

  it("can run a tool the config has not exposed: this is local, before anything is shared", async () => {
    const r = await callOnce({ server: { ...server, read: [], write: [] }, tool: "write_thing", arguments: { text: "x" } }, opts());
    expect(r.ok).toBe(true);
  });

  it("names the missing permission instead of echoing an AppleScript error", async () => {
    const r = await callOnce({ server, tool: "automation_denied", arguments: {} }, opts());
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toMatch(/Automation permission not granted/);
  });

  it("times out, reports bad input, and reports a server that cannot start", async () => {
    const slow = await callOnce({ server, tool: "slow", arguments: { ms: 5000 } }, { ...opts(), timeoutMs: 300 });
    expect(slow).toMatchObject({ ok: false, error: "timed out after 0 s" });
    expect(await callFromText("not json", opts())).toEqual({ ok: false, error: "invalid input: stdin is not JSON" });
    expect(await callOnce({ tool: "echo" }, opts())).toMatchObject({ ok: false });
    const missing = await callOnce({ server: { transport: "stdio", command: "/nonexistent/bin" }, tool: "echo" }, opts());
    expect(missing).toEqual({ ok: false, error: "could not start: ENOENT" });
  });

  it("refuses a result too large to print on one line", async () => {
    const r = await callOnce({ server, tool: "big", arguments: { bytes: 1_200_000 } }, opts());
    expect(r).toMatchObject({ ok: false });
    expect(!r.ok && r.error).toMatch(/larger than/);
  });
});

describe("inspect", () => {
  it("returns each tool's input schema for the app's Try form", async () => {
    const r = await inspectServer(server, opts());
    const echo = r.ok ? r.tools.find((t) => t.name === "echo") : undefined;
    expect(echo?.inputSchema).toMatchObject({ type: "object", properties: { text: { type: "string" } } });
  });
});
