// The status file: the writer on its own, then the whole daemon against a
// local cloud. Everything is written under a temp dir, never the real one.
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { decodeJwt } from "jose";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HelloSchema } from "../../infra/lib/shared/protocol";
import { runCli } from "../src/commands";
import { NoAccountError, startDaemon, type Daemon } from "../src/daemon";
import { DeviceKey } from "../src/device-key";
import type { ToolRunner } from "../src/servers";
import { StatusWriter, defaultStateDir, type StatusDocument } from "../src/status";
import { AGENT_VERSION } from "../src/version";
import { FakeCloud, resultFor, sendCall } from "./fake-cloud";
import { FIXTURE, capturingLogger, fakeSecurity, waitFor } from "./helpers";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "lb-status-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const read = async (path: string): Promise<StatusDocument | undefined> => {
  try {
    return JSON.parse(await readFile(path, "utf8")) as StatusDocument;
  } catch {
    return undefined; // not there yet
  }
};
/** Polls the file until `probe` accepts it. */
async function waitForStatus(path: string, probe: (doc: StatusDocument) => boolean, label: string): Promise<StatusDocument> {
  let last: StatusDocument | undefined;
  const started = Date.now();
  for (;;) {
    last = await read(path);
    if (last && probe(last)) return last;
    if (Date.now() - started > 10_000) throw new Error(`timed out waiting for status: ${label}; last ${JSON.stringify(last)}`);
    await sleep(15);
  }
}

describe("state directory", () => {
  it("defaults to Application Support and follows LOCAL_BRIDGE_STATE_DIR", () => {
    expect(defaultStateDir({})).toBe(join(homedir(), "Library", "Application Support", "local-bridge"));
    expect(defaultStateDir({ LOCAL_BRIDGE_STATE_DIR: "/tmp/elsewhere" })).toBe("/tmp/elsewhere");
  });
});

describe("status writer", () => {
  const fakeServers = () => {
    const listeners = new Set<() => void>();
    const runner: Pick<ToolRunner, "list" | "onChange"> & { emit(): void; servers: ReturnType<ToolRunner["list"]> } = {
      servers: [
        {
          name: "notes",
          title: "Apple Notes",
          status: "up",
          tools: [{ name: "search_notes", description: "secret description", inputSchema: { type: "object" }, access: "read" }],
        },
        { name: "ha", status: "down", error: "failed to start: ENOENT", tools: [] },
      ],
      list() {
        return this.servers;
      },
      onChange(l) {
        listeners.add(l);
        return () => listeners.delete(l);
      },
      emit() {
        for (const l of listeners) l();
      },
    };
    return runner;
  };

  it("writes the spec's shape, mode 0600, with nothing left beside it", async () => {
    const servers = fakeServers();
    const nested = join(dir, "made", "on", "demand");
    const w = new StatusWriter({ dir: nested, machine: "mini", account: "0123456789abcdef0123", servers, pid: 4242, now: () => 1_731_700_000_000 });
    await w.start();
    expect(w.path).toBe(join(nested, "status.json"));
    expect((await stat(w.path)).mode & 0o777).toBe(0o600);
    expect(await readdir(nested)).toEqual(["status.json"]);
    const text = await readFile(w.path, "utf8");
    expect(JSON.parse(text)).toEqual({
      pid: 4242,
      version: AGENT_VERSION,
      machine: "mini",
      account: "0123456789abcdef0123",
      updatedAt: 1_731_700_000_000,
      connection: { state: "connecting", since: 1_731_700_000_000, lastError: null },
      servers: [
        { name: "notes", title: "Apple Notes", status: "up", error: null, tools: [{ name: "search_notes", access: "read" }] },
        { name: "ha", title: null, status: "down", error: "failed to start: ENOENT", tools: [] },
      ],
      calls: { total: 0, failed: 0, lastAt: null, lastTool: null, lastOutcome: null },
    });
    expect(Object.keys(JSON.parse(text) as object)).toEqual(["pid", "version", "machine", "account", "updatedAt", "connection", "servers", "calls"]);
    expect(text).not.toContain("secret description");
    expect(text).not.toContain("inputSchema");
    await w.stop();
  });

  it("replaces a file that is already there, whatever its mode", async () => {
    await writeFile(join(dir, "status.json"), "stale", { mode: 0o644 });
    const w = new StatusWriter({ dir, machine: "mini", servers: fakeServers() });
    await w.start();
    expect((await stat(w.path)).mode & 0o777).toBe(0o600);
    expect(await read(w.path)).toMatchObject({ machine: "mini", account: null });
    await w.stop();
  });

  it("records connection changes and calls, and counts failures", async () => {
    const w = new StatusWriter({ dir, machine: "mini", servers: fakeServers(), minIntervalMs: 0 });
    await w.start();
    w.setConnection({ state: "connected", since: 111, lastError: null });
    w.recordCall({ server: "notes", tool: "search_notes", outcome: "ok", at: 1000 });
    w.recordCall({ server: "notes", tool: "get_note", outcome: "timeout", at: 2000 });
    const doc = await waitForStatus(w.path, (d) => d.calls.total === 2, "two calls");
    expect(doc.connection).toEqual({ state: "connected", since: 111, lastError: null });
    expect(doc.calls).toEqual({ total: 2, failed: 1, lastAt: 2000, lastTool: "notes.get_note", lastOutcome: "timeout" });
    w.setConnection({ state: "offline", since: 222, lastError: "auth_refused" });
    expect((await waitForStatus(w.path, (d) => d.connection.state === "offline", "offline")).connection).toEqual({
      state: "offline",
      since: 222,
      lastError: "auth_refused",
    });
    await w.stop();
  });

  it("rewrites when a server changes", async () => {
    const servers = fakeServers();
    const w = new StatusWriter({ dir, machine: "mini", servers, minIntervalMs: 0 });
    await w.start();
    servers.servers = [{ name: "notes", status: "down", error: "server exited", tools: [] }];
    servers.emit();
    const doc = await waitForStatus(w.path, (d) => d.servers.length === 1, "one server");
    expect(doc.servers).toEqual([{ name: "notes", title: null, status: "down", error: "server exited", tools: [] }]);
    await w.stop();
  });

  it("collapses a burst into a few writes and still lands the last state", async () => {
    const w = new StatusWriter({ dir, machine: "mini", servers: fakeServers(), minIntervalMs: 250 });
    await w.start();
    expect(w.writes).toBe(1);
    const started = Date.now();
    for (let i = 1; i <= 200; i++) {
      w.recordCall({ server: "notes", tool: `t${i}`, outcome: "ok", at: i });
      if (i % 20 === 0) await sleep(30);
    }
    const doc = await waitForStatus(w.path, (d) => d.calls.total === 200, "the last call");
    expect(doc.calls.lastTool).toBe("notes.t200");
    const elapsed = Date.now() - started;
    // At most one write per 250 ms, plus the one already under way.
    expect(w.writes - 1).toBeLessThanOrEqual(Math.ceil(elapsed / 250) + 1);
    expect(w.writes).toBeLessThan(10);
    await w.stop();
  });

  it("refreshes the file on a timer when nothing changes", async () => {
    let now = 1000;
    const w = new StatusWriter({ dir, machine: "mini", servers: fakeServers(), minIntervalMs: 0, refreshMs: 40, now: () => now });
    await w.start();
    now = 5000;
    expect((await waitForStatus(w.path, (d) => d.updatedAt === 5000, "a refresh")).updatedAt).toBe(5000);
    await w.stop();
  });

  it("removes the file on stop and writes nothing afterwards", async () => {
    const w = new StatusWriter({ dir, machine: "mini", servers: fakeServers(), minIntervalMs: 0, refreshMs: 20 });
    await w.start();
    w.recordCall({ server: "notes", tool: "x", outcome: "ok", at: 1 });
    await w.stop();
    expect(await readdir(dir)).toEqual([]);
    w.recordCall({ server: "notes", tool: "y", outcome: "ok", at: 2 });
    w.setConnection({ state: "connected", since: 1, lastError: null });
    await sleep(80);
    expect(await readdir(dir)).toEqual([]);
  });
});

describe("daemon status file against a local cloud", () => {
  let cloud: FakeCloud | undefined;
  let daemon: Daemon | undefined;
  const logs = capturingLogger();

  afterEach(async () => {
    await daemon?.stop(0);
    daemon = undefined;
    await cloud?.stop();
    cloud = undefined;
  });

  const ACCOUNT = "0123456789abcdef0123";
  const boot = async (servers: Record<string, unknown>): Promise<{ daemon: Daemon; statusPath: string; cloud: FakeCloud }> => {
    cloud ??= await FakeCloud.start();
    const configPath = join(dir, "config.json");
    await writeFile(configPath, JSON.stringify({ machine: "mini", endpoint: cloud.url, account: ACCOUNT, servers }), { mode: 0o600 });
    const fake = fakeSecurity();
    await new DeviceKey(fake.keychain, "mini").ensure();
    const stateDir = join(dir, "state");
    daemon = await startDaemon(configPath, {
      keychain: fake.keychain,
      log: logs.log,
      env: { LOCAL_BRIDGE_STATE_DIR: stateDir },
      timing: { backoffMinMs: 20, backoffMaxMs: 100, helloDebounceMs: 10, drainMs: 500 },
      serverOptions: { restartMinMs: 30, restartMaxMs: 200 },
      statusOptions: { minIntervalMs: 20 },
    });
    return { daemon, statusPath: join(stateDir, "status.json"), cloud };
  };
  const fix = (extra: Record<string, unknown> = {}) => ({
    transport: "stdio",
    command: process.execPath,
    args: [FIXTURE],
    read: ["echo", "boom"],
    write: ["write_thing"],
    ...extra,
  });

  it("follows connect, calls and disconnect, and is removed on shutdown", async () => {
    const before = Date.now();
    const { daemon, statusPath, cloud } = await boot({
      notes: fix({ title: "Apple Notes" }),
      plain: fix({ read: ["echo"], write: [] }),
      parked: fix({ enabled: false, title: "Parked", command: "/nonexistent/binary" }),
    });

    // Connected, with the servers that are enabled.
    const connected = await waitForStatus(statusPath, (d) => d.connection.state === "connected", "connected");
    expect(connected).toMatchObject({ pid: process.pid, version: "0.2.0", machine: "mini", account: ACCOUNT });
    expect(connected.updatedAt).toBeGreaterThanOrEqual(before);
    expect(connected.connection.lastError).toBeNull();
    expect(connected.connection.since).toBeGreaterThanOrEqual(before);
    expect(connected.servers).toEqual([
      {
        name: "notes",
        title: "Apple Notes",
        status: "up",
        error: null,
        tools: [
          { name: "echo", access: "read" },
          { name: "boom", access: "read" },
          { name: "write_thing", access: "write" },
        ],
      },
      { name: "plain", title: null, status: "up", error: null, tools: [{ name: "echo", access: "read" }] },
    ]);
    expect(connected.calls).toEqual({ total: 0, failed: 0, lastAt: null, lastTool: null, lastOutcome: null });
    expect((await stat(statusPath)).mode & 0o777).toBe(0o600);

    // Hello carries the title, and says nothing about the disabled server.
    const session = await cloud.session(0);
    // The upgrade's assertion names the account.
    expect(decodeJwt(session.authorization!.slice("Bearer ".length))).toMatchObject({ iss: "mini", sub: "mini", uid: ACCOUNT });
    const hello = await waitFor(() => session.messages.find((m) => m.type === "hello"), 5000, "hello");
    expect(HelloSchema.safeParse(hello).success).toBe(true);
    if (hello.type !== "hello") throw new Error("unreachable");
    expect(hello.agentVersion).toBe("0.2.0");
    expect(hello.servers.map((s) => s.name)).toEqual(["notes", "plain"]);
    expect(hello.servers[0]).toMatchObject({ name: "notes", title: "Apple Notes", status: "up" });
    expect(hello.servers[1]).not.toHaveProperty("title");

    // A call that works.
    sendCall(session, { callId: "c1", server: "notes", tool: "echo", arguments: { text: "ARGUMENT-CANARY" } });
    expect((await resultFor(session, "c1")).ok).toBe(true);
    const afterOk = await waitForStatus(statusPath, (d) => d.calls.total === 1, "one call");
    expect(afterOk.calls).toMatchObject({ total: 1, failed: 0, lastTool: "notes.echo", lastOutcome: "ok" });
    expect(afterOk.calls.lastAt).toBeGreaterThanOrEqual(before);

    // One the local server fails, and one to the disabled server.
    sendCall(session, { callId: "c2", server: "notes", tool: "boom", arguments: { text: "ARGUMENT-CANARY" } });
    expect(await resultFor(session, "c2")).toMatchObject({ ok: false, error: { code: "tool_error" } });
    const afterFail = await waitForStatus(statusPath, (d) => d.calls.total === 2, "two calls");
    expect(afterFail.calls).toMatchObject({ total: 2, failed: 1, lastTool: "notes.boom", lastOutcome: "tool_error" });

    sendCall(session, { callId: "c3", server: "parked", tool: "echo", arguments: { text: "ARGUMENT-CANARY" } });
    expect(await resultFor(session, "c3")).toMatchObject({ ok: false, error: { code: "not_exposed" } });
    const afterRefused = await waitForStatus(statusPath, (d) => d.calls.total === 3, "three calls");
    expect(afterRefused.calls).toMatchObject({ total: 3, failed: 2, lastTool: "parked.echo", lastOutcome: "not_exposed" });

    // Neither an argument nor a result ever reaches the file.
    expect(await readFile(statusPath, "utf8")).not.toContain("CANARY");

    // The cloud goes away: offline with the close code, and it stays offline while retrying.
    cloud.refuseWith = 503;
    session.socket.close(1001);
    const offline = await waitForStatus(statusPath, (d) => d.connection.state === "offline", "offline");
    expect(offline.connection.lastError).toMatch(/^(close_1001|http_503)$/);
    expect(offline.connection.since).toBeGreaterThanOrEqual(connected.connection.since);
    const refused = await waitForStatus(statusPath, (d) => d.connection.lastError === "http_503", "http_503");
    expect(refused.connection.state).toBe("offline");
    expect(refused.connection.since).toBe(offline.connection.since);
    expect(refused.calls.total).toBe(3);

    // And comes back.
    cloud.refuseWith = undefined;
    const back = await waitForStatus(statusPath, (d) => d.connection.state === "connected", "connected again");
    expect(back.connection.lastError).toBeNull();
    expect(back.connection.since).toBeGreaterThan(offline.connection.since - 1);

    // A clean stop removes the file.
    await daemon.stop(0);
    await expect(stat(statusPath)).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readdir(join(dir, "state"))).toEqual([]);
  }, 30_000);

  it("reports auth_refused when the upgrade is answered 401 or 403", async () => {
    cloud = await FakeCloud.start();
    for (const status of [401, 403]) {
      cloud.refuseWith = status;
      const { daemon: d, statusPath } = await boot({ notes: fix() });
      const doc = await waitForStatus(statusPath, (s) => s.connection.state === "offline", `offline after ${status}`);
      expect(doc.connection.lastError).toBe("auth_refused");
      // Still refused a few retries later, and still the same reason.
      await waitFor(() => logs.lines.filter((l) => l.includes('"event":"upgrade_refused"')).length >= 3, 5000, "retries");
      expect((await read(statusPath))?.connection).toMatchObject({ state: "offline", lastError: "auth_refused" });
      logs.lines.length = 0;
      await d.stop(0);
      daemon = undefined;
    }
    expect(cloud.sessions).toHaveLength(0);
  }, 30_000);

  it("reports an error class, not message text, when nothing is listening", async () => {
    cloud = await FakeCloud.start();
    const url = cloud.url;
    await cloud.stop();
    // Reuse the dead port: boot() writes the config from `cloud.url`.
    cloud = { url, stop: async () => {}, sessions: [] } as unknown as FakeCloud;
    const { statusPath } = await boot({ notes: fix() });
    const doc = await waitForStatus(statusPath, (s) => s.connection.state === "offline", "offline");
    expect(doc.connection.lastError).toMatch(/^\w*Error ECONNREFUSED$/);
  }, 30_000);

  it("refuses to run without an account, leaving a status file that says why", async () => {
    const configPath = join(dir, "config.json");
    // A server that would leave a marker if it were ever started.
    const marker = join(dir, "started");
    const servers = {
      notes: { transport: "stdio", command: process.execPath, args: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "x")`], read: [], write: [] },
    };
    await writeFile(configPath, JSON.stringify({ machine: "mini", endpoint: "ws://127.0.0.1:9", servers }), { mode: 0o600 });
    const fake = fakeSecurity();
    await new DeviceKey(fake.keychain, "mini").ensure();
    const stateDir = join(dir, "state");
    const before = Date.now();

    const attempt = startDaemon(configPath, { keychain: fake.keychain, log: logs.log, env: { LOCAL_BRIDGE_STATE_DIR: stateDir } });
    await expect(attempt).rejects.toBeInstanceOf(NoAccountError);
    await expect(attempt).rejects.toThrow("this Mac is not signed in to an account; open the Local Bridge app and sign in");

    const doc = (await read(join(stateDir, "status.json")))!;
    expect(doc).toMatchObject({
      pid: process.pid,
      version: "0.2.0",
      machine: "mini",
      account: null,
      connection: { state: "offline", lastError: "no_account" },
      servers: [],
      calls: { total: 0, failed: 0, lastAt: null, lastTool: null, lastOutcome: null },
    });
    expect(doc.updatedAt).toBeGreaterThanOrEqual(before);
    expect(doc.connection.since).toBe(doc.updatedAt);
    expect((await stat(join(stateDir, "status.json"))).mode & 0o777).toBe(0o600);
    expect(await readdir(stateDir)).toEqual(["status.json"]);
    await sleep(150);
    await expect(stat(marker)).rejects.toMatchObject({ code: "ENOENT" });

    // The CLI's `run` fails the same way: runCli rejects, and cli.ts turns that into one stderr line and exit 1.
    await rm(stateDir, { recursive: true, force: true });
    await expect(
      runCli(["run", "--config", configPath], { out: () => {}, keychain: fake.keychain, env: { LOCAL_BRIDGE_STATE_DIR: stateDir } }),
    ).rejects.toThrow(/^this Mac is not signed in to an account; open the Local Bridge app and sign in$/);
    expect((await read(join(stateDir, "status.json")))?.connection.lastError).toBe("no_account");
  });

  it("shows a server that cannot start as down with its reason", async () => {
    const { statusPath } = await boot({ notes: fix(), broken: fix({ command: "/nonexistent/binary" }) });
    const doc = await waitForStatus(statusPath, (d) => d.connection.state === "connected", "connected");
    expect(doc.servers[1]).toMatchObject({ name: "broken", title: null, status: "down", tools: [] });
    expect(doc.servers[1]!.error).toMatch(/^failed to start/);
  }, 30_000);
});
