// Integration: the real Connection and ServerManager against a local `ws`
// server that plays the cloud. Nothing leaves 127.0.0.1.
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { DEVICE_AUDIENCE, HelloSchema, PROTOCOL_VERSION } from "../../infra/lib/shared/protocol";
import { Connection, type ConnectionOptions } from "../src/connection";
import { DeviceKey, type PublicDeviceJwk } from "../src/device-key";
import { ServerManager } from "../src/servers";
import { FakeCloud, resultFor, sendCall, type Session } from "./fake-cloud";
import { capturingLogger, fakeSecurity, fixtureServer, waitFor } from "./helpers";

const hellos = (session: Session) => session.messages.filter((m) => m.type === "hello");

describe("connection against a local cloud", () => {
  let cloud: FakeCloud;
  let servers: ServerManager;
  let deviceKey: DeviceKey;
  let publicJwk: PublicDeviceJwk;
  let connection: Connection | undefined;
  const logs = capturingLogger();

  const connect = (over: Partial<ConnectionOptions> = {}): Connection => {
    connection = new Connection({
      machine: "mini",
      endpoint: cloud.url,
      servers,
      signAssertion: () => deviceKey.signAssertion(),
      log: logs.log,
      timing: { backoffMinMs: 20, backoffMaxMs: 100, helloDebounceMs: 10, drainMs: 500 },
      ...over,
    });
    connection.start();
    return connection;
  };

  beforeAll(async () => {
    const fake = fakeSecurity();
    deviceKey = new DeviceKey(fake.keychain, "mini");
    publicJwk = (await deviceKey.ensure()).jwk;
  });

  // A fresh cloud and server set per test keeps sessions and restarts independent.
  afterEach(async () => {
    await connection?.stop(0);
    connection = undefined;
    await servers?.stop();
    await cloud?.stop();
  });
  const setup = async () => {
    cloud = await FakeCloud.start();
    servers = new ServerManager({ fix: fixtureServer() }, { restartMinMs: 30, restartMaxMs: 200, log: logs.log });
    await servers.start();
  };

  it("authenticates the upgrade with a device assertion", async () => {
    await setup();
    connect();
    const session = await cloud.session(0);
    expect(session.authorization).toMatch(/^Bearer [\w-]+\.[\w-]+\.[\w-]+$/);
    const token = session.authorization!.slice("Bearer ".length);
    const key = await importJWK({ kty: publicJwk.kty, crv: publicJwk.crv, x: publicJwk.x }, "EdDSA");
    const { payload } = await jwtVerify(token, key, { audience: DEVICE_AUDIENCE, issuer: "mini", subject: "mini" });
    expect(payload.jti).toBeTruthy();
    expect(decodeProtectedHeader(token).kid).toBe(publicJwk.kid);
  });

  it("sends hello first, framed, and it decodes with the shared protocol", async () => {
    await setup();
    connect();
    const session = await cloud.session(0);
    const hello = await waitFor(() => session.messages[0], 5000, "hello");
    expect(HelloSchema.safeParse(hello).success).toBe(true);
    expect(hello).toMatchObject({ type: "hello", protocol: PROTOCOL_VERSION, machine: "mini" });
    if (hello.type !== "hello") throw new Error("unreachable");
    expect(hello.servers).toHaveLength(1);
    expect(hello.servers[0]).toMatchObject({ name: "fix", status: "up" });
    const names = hello.servers[0]!.tools.map((t) => t.name);
    expect(names).toContain("echo");
    expect(names).not.toContain("hidden");
    expect(hello.servers[0]!.tools.find((t) => t.name === "write_thing")?.access).toBe("write");
    expect(hello.servers[0]!.tools.find((t) => t.name === "echo")?.access).toBe("read");
  });

  it("answers a call with ack, then result", async () => {
    await setup();
    connect();
    const session = await cloud.session(0);
    await waitFor(() => session.messages.length >= 1);
    sendCall(session, { callId: "call-1", tool: "echo", arguments: { text: "from the cloud" } });
    const result = await resultFor(session, "call-1");
    expect(result).toEqual({ type: "result", callId: "call-1", ok: true, result: { content: [{ type: "text", text: "from the cloud" }] } });
    const ackIndex = session.messages.findIndex((m) => m.type === "ack" && m.callId === "call-1");
    expect(ackIndex).toBeGreaterThan(0);
    expect(ackIndex).toBeLessThan(session.messages.indexOf(result));
  });

  it("refuses a call whose deadline has passed, allowing for clock skew", async () => {
    await setup();
    connect();
    const session = await cloud.session(0);
    sendCall(session, { callId: "old", tool: "echo", arguments: { text: "stale" }, deadline: Date.now() - 31_000 });
    const result = await resultFor(session, "old");
    expect(result).toMatchObject({ ok: false, error: { code: "expired" } });
    expect(session.messages.some((m) => m.type === "ack" && m.callId === "old")).toBe(true);
    // No tool ran for it.
    expect(logs.lines.some((l) => l.includes('"event":"call"') && l.includes('"callId":"old"'))).toBe(false);

    // Inside the 30 s allowance it still runs.
    sendCall(session, { callId: "skewed", tool: "echo", arguments: { text: "ok" }, deadline: Date.now() - 5_000 });
    expect(await resultFor(session, "skewed")).toMatchObject({ ok: true });
  });

  it("refuses a tool the machine's config does not expose", async () => {
    await setup();
    connect();
    const session = await cloud.session(0);
    sendCall(session, { callId: "h1", tool: "hidden" });
    expect(await resultFor(session, "h1")).toMatchObject({ ok: false, error: { code: "not_exposed" } });
    sendCall(session, { callId: "h2", tool: "echo", server: "nosuch" });
    expect(await resultFor(session, "h2")).toMatchObject({ ok: false, error: { code: "not_exposed" } });
  });

  it("sends a 200 KB result as several frames, each under 32 KB", async () => {
    await setup();
    connect();
    const session = await cloud.session(0);
    sendCall(session, { callId: "big-1", tool: "big", arguments: { bytes: 200_000 }, maxResultBytes: 1_048_576 });
    const result = await resultFor(session, "big-1");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect((result.result.content[0] as { text: string }).text).toHaveLength(200_000);
    expect(session.frameCounts.get(result)).toBeGreaterThanOrEqual(12);
    expect(Math.max(...session.rawSizes)).toBeLessThan(32 * 1024);
  });

  it("keeps an oversize result off the wire", async () => {
    await setup();
    connect();
    const session = await cloud.session(0);
    sendCall(session, { callId: "big-2", tool: "big", arguments: { bytes: 200_000 }, maxResultBytes: 50_000 });
    const result = await resultFor(session, "big-2");
    expect(result).toMatchObject({ ok: false, error: { code: "too_large" } });
    expect(session.frameCounts.get(result)).toBe(1);
    expect(Math.max(...session.rawSizes)).toBeLessThan(32 * 1024);
  });

  it("aborts a running call on cancel", async () => {
    await setup();
    connect();
    const session = await cloud.session(0);
    sendCall(session, { callId: "slow-1", tool: "slow", arguments: { ms: 8000 } });
    await waitFor(() => session.messages.some((m) => m.type === "ack" && m.callId === "slow-1"));
    session.socket.send(JSON.stringify({ type: "cancel", callId: "slow-1" }));
    expect(await resultFor(session, "slow-1", 3000)).toMatchObject({ ok: false, error: { code: "cancelled" } });
  });

  it("ignores messages that are not valid protocol", async () => {
    await setup();
    connect();
    const session = await cloud.session(0);
    session.socket.send("not json");
    session.socket.send(JSON.stringify({ type: "call", callId: "bad", server: "Not A Name", tool: "echo", arguments: {}, deadline: Date.now() + 1000, maxResultBytes: 10 }));
    session.socket.send(JSON.stringify({ type: "shutdown" }));
    sendCall(session, { callId: "after", tool: "echo", arguments: { text: "alive" } });
    expect(await resultFor(session, "after")).toMatchObject({ ok: true });
    expect(session.messages.some((m) => "callId" in m && m.callId === "bad")).toBe(false);
  });

  it("reconnects after the cloud closes the socket, with a fresh assertion and a new hello", async () => {
    await setup();
    connect();
    const first = await cloud.session(0);
    await waitFor(() => hellos(first).length === 1);
    first.socket.close(1001);
    const second = await cloud.session(1);
    await waitFor(() => hellos(second).length === 1);
    expect(second.authorization).not.toBe(first.authorization);
    sendCall(second, { callId: "again", tool: "echo", arguments: { text: "second socket" } });
    expect(await resultFor(second, "again")).toMatchObject({ ok: true });
  });

  it("never delivers a result on a later socket", async () => {
    await setup();
    connect();
    const first = await cloud.session(0);
    sendCall(first, { callId: "lost", tool: "slow", arguments: { ms: 400 } });
    await waitFor(() => first.messages.some((m) => m.type === "ack" && m.callId === "lost"));
    first.socket.terminate();
    const second = await cloud.session(1);
    await waitFor(() => hellos(second).length === 1);
    await new Promise((r) => setTimeout(r, 700));
    expect(second.messages.some((m) => m.type === "result")).toBe(false);
  });

  it("sends hello again when a server goes down and when it comes back", async () => {
    await setup();
    connect();
    const session = await cloud.session(0);
    await waitFor(() => hellos(session).length === 1);
    sendCall(session, { callId: "crash-1", tool: "crash" });
    expect(await resultFor(session, "crash-1")).toMatchObject({ ok: false, error: { code: "server_down" } });
    const down = await waitFor(() => hellos(session).find((h) => h.type === "hello" && h.servers[0]?.status === "down"), 5000, "hello with server down");
    if (down.type !== "hello") throw new Error("unreachable");
    expect(down.servers[0]!.tools).toEqual([]);
    await waitFor(() => {
      const last = hellos(session).at(-1);
      return last?.type === "hello" && last.servers[0]?.status === "up" && hellos(session).length >= 3;
    }, 10_000, "hello with server back up");
  });

  it("sends heartbeats with server status and no tool lists", async () => {
    await setup();
    connect({ timing: { heartbeatMs: 40, backoffMinMs: 20 } });
    const session = await cloud.session(0);
    const hb = await waitFor(() => session.messages.find((m) => m.type === "hb"), 3000, "heartbeat");
    expect(hb).toEqual({ type: "hb", servers: [{ name: "fix", status: "up" }] });
  });

  it("announces a pending rotation key and switches to it once the cloud confirms", async () => {
    await setup();
    const fake = fakeSecurity();
    const key = new DeviceKey(fake.keychain, "mini");
    const current = (await key.ensure()).jwk;
    const next = await key.prepareRotation();
    connect({
      signAssertion: () => key.signAssertion(),
      pendingRotation: () => key.pendingRotation(),
      onRotated: (kid) => key.promote(kid),
    });
    const first = await cloud.session(0);
    expect(decodeProtectedHeader(first.authorization!.slice(7)).kid).toBe(current.kid);
    const rotate = await waitFor(() => first.messages.find((m) => m.type === "rotate"), 5000, "rotate");
    expect(rotate).toEqual({ type: "rotate", kid: next.kid, jwk: { kty: "OKP", crv: "Ed25519", x: next.x } });
    expect(first.messages[0]!.type).toBe("hello");

    first.socket.send(JSON.stringify({ type: "rotated", kid: next.kid }));
    const second = await cloud.session(1);
    expect(decodeProtectedHeader(second.authorization!.slice(7)).kid).toBe(next.kid);
    await waitFor(() => hellos(second).length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(second.messages.some((m) => m.type === "rotate")).toBe(false);
  });

  it("stops cleanly: finishes the in-flight call, then closes and stays closed", async () => {
    await setup();
    const c = connect();
    const session = await cloud.session(0);
    sendCall(session, { callId: "last", tool: "slow", arguments: { ms: 150 } });
    await waitFor(() => session.messages.some((m) => m.type === "ack" && m.callId === "last"));
    await c.stop(2000);
    await waitFor(() => session.closed, 3000, "socket closed");
    expect(session.messages.find((m) => m.type === "result" && m.callId === "last")).toMatchObject({ ok: true });
    await new Promise((r) => setTimeout(r, 150));
    expect(cloud.sessions).toHaveLength(1);
  });

  it("never logs arguments or results", async () => {
    await setup();
    connect();
    const session = await cloud.session(0);
    const marker = "VERY-PRIVATE-TEXT-90210";
    sendCall(session, { callId: "priv", tool: "echo", arguments: { text: marker } });
    await resultFor(session, "priv");
    sendCall(session, { callId: "priv2", tool: "boom", arguments: { text: marker } });
    const failed = await resultFor(session, "priv2");
    expect(JSON.stringify(failed)).not.toContain(marker);
    expect(logs.lines.join("\n")).not.toContain(marker);
    expect(logs.lines.some((l) => l.includes('"callId":"priv"'))).toBe(true);
  });
});
