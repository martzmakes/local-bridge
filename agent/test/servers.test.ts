import { afterEach, describe, expect, it } from "vitest";
import { ServerInfoSchema } from "../../infra/lib/shared/protocol";
import type { ServerConfig } from "../src/config";
import { ServerManager, permissionMessage, type CallOptions, type ServerManagerOptions } from "../src/servers";
import { capturingLogger, fixtureServer, waitFor } from "./helpers";

const managers: ServerManager[] = [];
async function start(servers: Record<string, ServerConfig>, opts: ServerManagerOptions = {}): Promise<ServerManager> {
  const m = new ServerManager(servers, { restartMinMs: 30, restartMaxMs: 200, ...opts });
  managers.push(m);
  await m.start();
  return m;
}
afterEach(async () => {
  await Promise.all(managers.splice(0).map((m) => m.stop()));
});

let seq = 0;
const call = (over: Partial<CallOptions> = {}): CallOptions => ({
  callId: `c${++seq}`,
  deadline: Date.now() + 10_000,
  maxResultBytes: 262_144,
  ...over,
});

describe("exposure", () => {
  it("lists only the tools the config names, with the config's access class", async () => {
    const m = await start({ fix: fixtureServer({ read: ["echo", "write_thing", "not_a_real_tool"], write: ["write_thing"] }) });
    const [info] = m.list();
    expect(ServerInfoSchema.safeParse(info).success).toBe(true);
    expect(info).toMatchObject({ name: "fix", status: "up" });
    expect(info!.tools.map((t) => [t.name, t.access])).toEqual([
      ["echo", "read"],
      ["write_thing", "write"], // named in both lists: write wins
    ]);
    expect(info!.tools[0]).toMatchObject({ description: "Returns its text argument", inputSchema: { type: "object" } });

    const [report] = m.report();
    expect(report!.unexposed).toContain("hidden");
    expect(report!.unexposed).toContain("big");
    expect(report!.unexposed).not.toContain("echo");
    expect(report!.missing).toEqual(["not_a_real_tool"]);
  });

  it("announces the connector UUID and refuses a call for a stale UUID", async () => {
    const endpointId = "b29ab3da-6ab8-4f28-9cc3-bf91ab8a22cf";
    const m = await start({ fix: fixtureServer({ endpointId }) });
    expect(ServerInfoSchema.parse(m.list()[0]).endpointId).toBe(endpointId);
    const stale = call({ endpointId: "794014de-0d7e-4661-a3e8-6cd612ddeb90" });
    expect(await m.callTool("fix", "echo", { text: "ignored" }, stale)).toMatchObject({
      ok: false, error: { code: "not_exposed" },
    });
    expect(await m.callTool("fix", "echo", { text: "hello" }, call({ endpointId }))).toMatchObject({ ok: true });
  });

  it("runs an exposed tool", async () => {
    const m = await start({ fix: fixtureServer() });
    const res = await m.callTool("fix", "echo", { text: "hello" }, call({ callId: "abc" }));
    expect(res).toEqual({ type: "result", callId: "abc", ok: true, result: { content: [{ type: "text", text: "hello" }] } });
  });

  it("refuses an unknown server, an unexposed tool, and a tool the server does not have", async () => {
    const m = await start({ fix: fixtureServer({ read: ["echo", "ghost"], write: [] }) });
    for (const [server, tool] of [["nope", "echo"], ["fix", "hidden"], ["fix", "write_thing"], ["fix", "ghost"]] as const) {
      const res = await m.callTool(server, tool, {}, call());
      expect(res.ok).toBe(false);
      if (!res.ok) expect(res.error.code).toBe("not_exposed");
    }
  });
});

describe("limits", () => {
  it("refuses a result over maxResultBytes and reports both byte counts", async () => {
    const m = await start({ fix: fixtureServer() });
    const res = await m.callTool("fix", "big", { bytes: 5000 }, call({ maxResultBytes: 1000 }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("too_large");
    expect(res.error.message).toMatch(/^result too large \((\d+) bytes, limit 1000\)$/);
    expect(Number(/\((\d+) bytes/.exec(res.error.message)![1])).toBeGreaterThan(5000);
    expect(res.error.message).not.toContain("xxxx");

    const fits = await m.callTool("fix", "big", { bytes: 500 }, call({ maxResultBytes: 1000 }));
    expect(fits.ok).toBe(true);
  });

  it("times out at the deadline and keeps working afterwards", async () => {
    const m = await start({ fix: fixtureServer() });
    const started = Date.now();
    const res = await m.callTool("fix", "slow", { ms: 5000 }, call({ deadline: Date.now() + 200 }));
    expect(Date.now() - started).toBeLessThan(2000);
    expect(res).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(await m.callTool("fix", "echo", { text: "still here" }, call())).toMatchObject({ ok: true });
  });

  it("applies the server's own callTimeoutMs on top of the deadline", async () => {
    const m = await start({ fix: fixtureServer({ callTimeoutMs: 150 }) });
    const res = await m.callTool("fix", "slow", { ms: 5000 }, call());
    expect(res).toMatchObject({ ok: false, error: { code: "timeout" } });
  });

  it("cancels a running call and a queued call", async () => {
    const m = await start({ fix: fixtureServer() });
    const running = new AbortController();
    const queued = new AbortController();
    const a = m.callTool("fix", "slow", { ms: 5000 }, call({ signal: running.signal }));
    const b = m.callTool("fix", "echo", { text: "queued" }, call({ signal: queued.signal }));
    queued.abort();
    expect(await b).toMatchObject({ ok: false, error: { code: "cancelled" } });
    running.abort();
    expect(await a).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(await m.callTool("fix", "echo", { text: "x" }, call())).toMatchObject({ ok: true });
  });

  it("runs one call at a time per server by default, queuing the rest", async () => {
    const m = await start({ fix: fixtureServer() });
    const started = Date.now();
    const results = await Promise.all([1, 2, 3].map(() => m.callTool("fix", "slow", { ms: 150 }, call())));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(Date.now() - started).toBeGreaterThanOrEqual(440);
  });

  it("honours a higher per-server concurrency", async () => {
    const m = await start({ fix: fixtureServer({ concurrency: 3 }) });
    const started = Date.now();
    await Promise.all([1, 2, 3].map(() => m.callTool("fix", "slow", { ms: 300 }, call())));
    expect(Date.now() - started).toBeLessThan(800);
  });

  it("answers busy beyond four calls in flight", async () => {
    const m = await start({ fix: fixtureServer() });
    const four = [1, 2, 3, 4].map(() => m.callTool("fix", "slow", { ms: 80 }, call()));
    const fifth = await m.callTool("fix", "echo", { text: "x" }, call());
    expect(fifth).toMatchObject({ ok: false, error: { code: "busy" } });
    expect((await Promise.all(four)).every((r) => r.ok)).toBe(true);
    expect(await m.callTool("fix", "echo", { text: "x" }, call())).toMatchObject({ ok: true });
  });
});

describe("errors", () => {
  it("reduces a thrown error to a class, in the reply and in the log", async () => {
    const { log, lines } = capturingLogger();
    const m = await start({ fix: fixtureServer() }, { log });
    const marker = "PRIVATE-ARGUMENT-4711";
    const res = await m.callTool("fix", "boom", { text: marker }, call({ callId: "boom1" }));
    expect(res.ok).toBe(false);
    if (res.ok) return;
    expect(res.error.code).toBe("tool_error");
    expect(res.error.message).toMatch(/McpError/);
    expect(res.error.message).not.toContain(marker);
    expect(res.error.message).not.toContain("could not process");

    await m.callTool("fix", "echo", { text: marker }, call({ callId: "echo1" }));
    const all = lines.join("\n");
    expect(all).not.toContain(marker);
    const callLines = lines.map((l) => JSON.parse(l) as Record<string, unknown>).filter((l) => l.event === "call");
    expect(callLines).toHaveLength(2);
    expect(callLines[0]).toMatchObject({ callId: "boom1", server: "fix", tool: "boom", outcome: "tool_error" });
    expect(callLines[1]).toMatchObject({ callId: "echo1", tool: "echo", outcome: "ok" });
    expect(typeof callLines[1]!.resultBytes).toBe("number");
    expect(typeof callLines[1]!.ms).toBe("number");
    for (const l of callLines) expect(Object.keys(l).sort()).toEqual(expect.not.arrayContaining(["arguments", "args", "result", "message"]));
  });

  it("maps macOS permission failures, whether returned or thrown", async () => {
    const m = await start({ fix: fixtureServer() });
    expect(await m.callTool("fix", "automation_denied", {}, call())).toMatchObject({
      ok: false,
      error: { code: "permission", message: "Automation permission not granted for Notes" },
    });
    expect(await m.callTool("fix", "automation_thrown", {}, call())).toMatchObject({
      ok: false,
      error: { code: "permission", message: "Automation permission not granted for Contacts" },
    });
    expect(await m.callTool("fix", "disk_denied", {}, call())).toMatchObject({
      ok: false,
      error: { code: "permission", message: "Full Disk Access not granted" },
    });
  });

  it("recognises the permission phrasings", () => {
    expect(permissionMessage("osascript: execution error: Notes got an error: (-1743)")).toBe("Automation permission not granted for the target app");
    expect(permissionMessage("Not authorised to send Apple events to System Events.")).toBe("Automation permission not granted for System Events");
    expect(permissionMessage("SQLITE_CANTOPEN: unable to open database file")).toBe("Full Disk Access not granted");
    expect(permissionMessage("note not found")).toBeUndefined();
  });
});

describe("title and enabled", () => {
  it("announces a title when the config sets one, and none otherwise", async () => {
    const m = await start({ notes: fixtureServer({ title: "Apple Notes" }), plain: fixtureServer() });
    const byName = Object.fromEntries(m.list().map((s) => [s.name, s]));
    expect(byName.notes).toMatchObject({ name: "notes", title: "Apple Notes", status: "up" });
    expect(ServerInfoSchema.parse(byName.notes).title).toBe("Apple Notes");
    expect(byName.plain).not.toHaveProperty("title");
  });

  it("neither starts nor lists a disabled server, and refuses calls to it as not_exposed", async () => {
    const m = await start({
      on: fixtureServer(),
      // A command that cannot run: starting it would leave a "down" entry behind.
      off: fixtureServer({ enabled: false, command: "/nonexistent/binary" }),
      alsooff: fixtureServer({ enabled: false }),
    });
    expect(m.list().map((s) => s.name)).toEqual(["on"]);
    expect(m.statuses().map((s) => s.name)).toEqual(["on"]);
    expect(m.report().map((s) => s.name)).toEqual(["on"]);
    for (const server of ["off", "alsooff"]) {
      const res = await m.callTool(server, "echo", { text: "x" }, call());
      expect(res).toMatchObject({ ok: false, error: { code: "not_exposed" } });
    }
    expect((await m.callTool("on", "echo", { text: "x" }, call())).ok).toBe(true);
  });
});

describe("lifecycle", () => {
  it("reports a server that cannot start as down, without stopping the others", async () => {
    const m = await start({
      fix: fixtureServer(),
      broken: { transport: "stdio", command: "/nonexistent/binary", args: [], read: ["x"], write: [], concurrency: 1, enabled: true },
    });
    const byName = Object.fromEntries(m.list().map((s) => [s.name, s]));
    expect(byName.fix).toMatchObject({ status: "up" });
    expect(byName.broken).toMatchObject({ status: "down", tools: [] });
    expect(byName.broken!.error).toMatch(/failed to start/);
    expect(ServerInfoSchema.safeParse(byName.broken).success).toBe(true);
    expect(m.statuses().find((s) => s.name === "broken")).toMatchObject({ status: "down" });
    expect(await m.callTool("broken", "x", {}, call())).toMatchObject({ ok: false, error: { code: "server_down" } });
    expect(await m.callTool("fix", "echo", { text: "ok" }, call())).toMatchObject({ ok: true });
  });

  it("restarts a crashed server with backoff and tells listeners", async () => {
    const m = await start({ fix: fixtureServer() });
    let changes = 0;
    m.onChange(() => changes++);

    const res = await m.callTool("fix", "crash", {}, call());
    expect(res).toMatchObject({ ok: false, error: { code: "server_down" } });
    await waitFor(() => m.list()[0]!.status === "down" || changes >= 2, 5000, "server down");
    expect(changes).toBeGreaterThanOrEqual(1);

    await waitFor(() => m.list()[0]!.status === "up", 10_000, "server back up");
    expect(changes).toBeGreaterThanOrEqual(2);
    expect(m.list()[0]!.tools.length).toBeGreaterThan(0);
    expect(await m.callTool("fix", "echo", { text: "back" }, call())).toMatchObject({ ok: true });
  });

  it("scrubs Keychain values from a reported startup error", async () => {
    const secret = ["synthetic", "keychain", "redaction", "fixture"].join("-");
    const m = await start(
      { broken: { transport: "stdio", command: `/nonexistent/${secret}/bin`, args: [], read: ["x"], write: [], concurrency: 1, enabled: true } },
      { secrets: [secret] },
    );
    const error = m.list()[0]!.error!;
    expect(error).not.toContain(secret);
    expect(error).toContain("[redacted]");
  });
});
