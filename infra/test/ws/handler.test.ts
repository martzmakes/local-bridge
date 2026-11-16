import { handleEvent, type WsDeps } from "../../lib/lambdas/ws/handler";
import { encodeFrames, type CloudMessage, type MachineMessage } from "../../lib/shared/protocol";

function fakeStore() {
  const log: Array<[string, ...unknown[]]> = [];
  const frames = new Map<string, Map<number, string>>();
  const done = new Set<string>();
  const store = {
    log,
    bindConnection: async (...a: unknown[]) => void log.push(["bindConnection", ...a]),
    unbindConnection: async (...a: unknown[]) => void log.push(["unbindConnection", ...a]),
    getMachine: async (id: string) => ({ id, enabled: true, keys: [{ kid: "k1", jwk: { kty: "OKP" as const, crv: "Ed25519" as const, x: "x".repeat(43) }, addedAt: 0 }] }),
    putMachineRegistration: async (...a: unknown[]) => void log.push(["putMachineRegistration", ...a]),
    connection: async (connectionId: string) => (connectionId === "conn-mini" ? { machine: "mini", kid: "k1" } : null),
    replaceServers: async (...a: unknown[]) => void log.push(["replaceServers", ...a]),
    heartbeat: async (...a: unknown[]) => void log.push(["heartbeat", ...a]),
    ackCall: async (...a: unknown[]) => void log.push(["ackCall", ...a]),
    completeCall: async (...a: unknown[]) => {
      log.push(["completeCall", ...a]);
      return true;
    },
    addFrame: async (conn: string, id: string, i: number, n: number, d: string) => {
      const k = `${conn}#${id}`;
      if (!frames.has(k)) frames.set(k, new Map());
      frames.get(k)!.set(i, d);
      if (frames.get(k)!.size < n || done.has(k)) return null;
      done.add(k);
      return [...frames.get(k)!.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
    },
  };
  return store;
}

function setup() {
  const store = fakeStore();
  const pushed: Array<[string, CloudMessage]> = [];
  const deps = { store, push: async (c: string, m: CloudMessage) => void pushed.push([c, m]), now: () => 1_000 } as unknown as WsDeps;
  const send = async (message: MachineMessage, connectionId = "conn-mini", order?: number[]) => {
    const frames = encodeFrames(message, "m1");
    const seq = order ?? frames.map((_, i) => i);
    let last;
    for (const i of seq) last = await handleEvent({ requestContext: { routeKey: "$default", connectionId }, body: JSON.stringify(frames[i]) }, deps);
    return last;
  };
  return { store, pushed, deps, send };
}

const hello: MachineMessage = {
  type: "hello", protocol: 1, machine: "mini", agentVersion: "0.1.0",
  servers: [{ name: "notes", status: "up", tools: [{ name: "search_notes", inputSchema: { type: "object" }, access: "read" }] }],
};

describe("machine channel", () => {
  it("binds the connection to the machine the authorizer verified", async () => {
    const { store, deps } = setup();
    const r = await handleEvent({ requestContext: { routeKey: "$connect", connectionId: "c9", authorizer: { machine: "mini", kid: "k1" } } }, deps);
    expect(r).toMatchObject({ statusCode: 200 });
    expect(store.log[0]).toEqual(["bindConnection", "mini", "c9", "k1"]);
  });

  it("refuses a connect that did not come through the authorizer", async () => {
    const { deps } = setup();
    expect(await handleEvent({ requestContext: { routeKey: "$connect", connectionId: "c9" } }, deps)).toMatchObject({ statusCode: 401 });
  });

  it("replaces the catalog on hello and answers welcome", async () => {
    const { store, pushed, send } = setup();
    await send(hello);
    expect(store.log[0]).toEqual(["replaceServers", "mini", "conn-mini", "0.1.0", (hello as { servers: unknown }).servers]);
    expect(pushed[0]).toEqual(["conn-mini", { type: "welcome", machine: "mini", serverTime: 1_000 }]);
  });

  it("refuses a hello that claims to be a different machine", async () => {
    const { store, send } = setup();
    expect(await send({ ...hello, machine: "air" } as MachineMessage)).toMatchObject({ statusCode: 403 });
    expect(store.log).toHaveLength(0);
  });

  it("ignores messages from a connection it does not know", async () => {
    const { store, send } = setup();
    expect(await send({ type: "ack", callId: "c1" }, "conn-stranger")).toMatchObject({ statusCode: 403 });
    expect(store.log).toHaveLength(0);
  });

  it("attributes a result to the connection's machine, not to anything in the message", async () => {
    const { store, send } = setup();
    await send({ type: "result", callId: "c1", ok: true, result: { content: [{ type: "text", text: "r" }] } });
    expect(store.log[0].slice(0, 3)).toEqual(["completeCall", "c1", "mini"]);
  });

  it("assembles a large result from frames that arrive out of order, exactly once", async () => {
    const { store, send } = setup();
    const big: MachineMessage = { type: "result", callId: "c2", ok: true, result: { content: [{ type: "text", text: "z".repeat(60_000) }] } };
    const n = encodeFrames(big, "m1").length;
    expect(n).toBeGreaterThan(2);
    await send(big, "conn-mini", [...Array(n).keys()].reverse());
    const completes = store.log.filter((l) => l[0] === "completeCall");
    expect(completes).toHaveLength(1);
    expect(JSON.parse((completes[0][3] as { resultJson: string }).resultJson).content[0].text).toHaveLength(60_000);
  });

  it("rejects bodies that are not frames", async () => {
    const { deps } = setup();
    expect(await handleEvent({ requestContext: { routeKey: "$default", connectionId: "conn-mini" }, body: '{"type":"hello"}' }, deps)).toMatchObject({ statusCode: 400 });
    expect(await handleEvent({ requestContext: { routeKey: "$default", connectionId: "conn-mini" }, body: "not json" }, deps)).toMatchObject({ statusCode: 400 });
  });

  it("adds a rotated key and confirms it", async () => {
    const { store, pushed, send } = setup();
    await send({ type: "rotate", kid: "k2", jwk: { kty: "OKP", crv: "Ed25519", x: "y".repeat(43) } });
    const [, machine, enabled, keys] = store.log[0] as [string, string, boolean, Array<{ kid: string; expiresAt?: number }>];
    expect([machine, enabled]).toEqual(["mini", true]);
    expect(keys.map((k) => [k.kid, k.expiresAt !== undefined])).toEqual([["k1", true], ["k2", false]]);
    expect(pushed[0][1]).toEqual({ type: "rotated", kid: "k2" });
  });
});
