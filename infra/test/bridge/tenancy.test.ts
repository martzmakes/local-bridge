// Two accounts on one table. A store bound to one account must not be able to
// read, list, call or audit anything in the other, including when both use
// the same machine and agent names. Runs against an in-memory DynamoDB fake
// that implements the operations and condition shapes the Store uses.
import { mockClient } from "aws-sdk-client-mock";
import { DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, UpdateCommand, DeleteCommand, BatchWriteCommand } from "@aws-sdk/lib-dynamodb";
import { Store } from "../../lib/lambdas/bridge/store";
import { handleAccount, kidFor } from "../../lib/lambdas/account/handler";
import { uidFromEmail } from "../../lib/lambdas/bridge/tenant";

type Item = Record<string, any>;

function fakeTable() {
  const items = new Map<string, Item>();
  const k = (pk: string, sk: string) => `${pk}\u0000${sk}`;
  const mock = mockClient(DynamoDBDocumentClient);
  const conditionFail = () => Object.assign(new Error("conditional"), { name: "ConditionalCheckFailedException" });

  mock.on(GetCommand).callsFake((i) => ({ Item: items.get(k(i.Key.pk, i.Key.sk)) }));
  mock.on(PutCommand).callsFake((i) => {
    const key = k(i.Item.pk, i.Item.sk);
    if (i.ConditionExpression === "attribute_not_exists(pk)" && items.has(key)) throw conditionFail();
    items.set(key, { ...i.Item });
    return {};
  });
  mock.on(DeleteCommand).callsFake((i) => (items.delete(k(i.Key.pk, i.Key.sk)), {}));
  mock.on(BatchWriteCommand).callsFake((i) => {
    for (const reqs of Object.values(i.RequestItems) as any[]) for (const r of reqs) items.delete(k(r.DeleteRequest.Key.pk, r.DeleteRequest.Key.sk));
    return {};
  });
  mock.on(QueryCommand).callsFake((i) => {
    const v = i.ExpressionAttributeValues;
    const out = [...items.values()].filter((it) => {
      if (it.pk !== v[":pk"]) return false;
      if (v[":p"] !== undefined && !String(it.sk).startsWith(v[":p"])) return false;
      if (v[":done"] !== undefined && !(String(it.sk) < v[":done"])) return false;
      return true;
    });
    out.sort((a, b) => String(a.sk).localeCompare(String(b.sk)));
    return { Items: i.ScanIndexForward === false ? out.reverse() : out };
  });
  mock.on(UpdateCommand).callsFake((i) => {
    const key = k(i.Key.pk, i.Key.sk);
    const item = items.get(key);
    const v = i.ExpressionAttributeValues ?? {};
    const cond: string = i.ConditionExpression ?? "";
    if (cond === "attribute_exists(meta)" && !item?.meta) throw conditionFail();
    if (cond === "connectionId = :c" && item?.connectionId !== v[":c"]) throw conditionFail();
    if (cond.startsWith("uid = :u AND machine = :m")) {
      const from = Object.keys(v).filter((x) => x.startsWith(":f")).map((x) => v[x]);
      if (!item || item.uid !== v[":u"] || item.machine !== v[":m"] || !from.includes(item.status)) throw conditionFail();
    }
    if (cond.startsWith("attribute_not_exists(n)") && item && item.n >= v[":limit"]) throw conditionFail();
    const next: Item = { ...(item ?? { pk: i.Key.pk, sk: i.Key.sk }) };
    const expr: string = i.UpdateExpression;
    const names = i.ExpressionAttributeNames ?? {};
    const add = /ADD (\w+) (:\w+)/.exec(expr);
    if (add) next[add[1]] = (next[add[1]] ?? 0) + v[add[2]];
    const remove = /REMOVE (\w+)/.exec(expr);
    if (remove) delete next[remove[1]];
    const set = /SET (.+?)(?: REMOVE| ADD|$)/.exec(expr.replace(/^ADD \w+ :\w+ /, ""));
    if (set) for (const part of set[1].split(",")) {
      const [lhs, rhs] = part.split("=").map((x) => x.trim());
      next[names[lhs] ?? lhs] = v[rhs];
    }
    items.set(key, next);
    return {};
  });
  return { items, ddb: mock as unknown as DynamoDBDocumentClient, restore: () => mock.restore() };
}

const ALICE = uidFromEmail("alice@example.com");
const BOB = uidFromEmail("Bob@Example.com");
const JWK = (c: string) => ({ kty: "OKP" as const, crv: "Ed25519" as const, x: c.repeat(43) });

describe("accounts are isolated", () => {
  let t: ReturnType<typeof fakeTable>;
  let root: Store;
  let alice: Store;
  let bob: Store;
  beforeEach(async () => {
    t = fakeTable();
    root = new Store(t.ddb, "table");
    alice = root.forTenant(ALICE);
    bob = root.forTenant(BOB);
    // Both accounts have a machine called "mini" with a "notes" server, and an agent called "coach".
    for (const [s, c] of [[alice, "A"], [bob, "B"]] as const) {
      await s.putMachineRegistration("mini", true, [{ kid: `kid-${c}`, jwk: JWK(c), addedAt: 1 }]);
      await s.bindConnection("mini", `conn-${c}`, `kid-${c}`);
      await s.replaceServers("mini", `conn-${c}`, "0.2.0", [
        { name: "notes", title: `${c} notes`, status: "up", tools: [{ name: `tool_of_${c}`, inputSchema: {}, access: "read" }] },
      ]);
      await s.putAgent({ id: "coach", enabled: true, tokenVersion: 1, ratePerMinute: 1, ratePerDay: 10, maxArgBytes: 1, maxResultBytes: 1, callTimeoutMs: 1, createdAt: 0 });
      await s.putRule("coach", { tool: `mini.notes.tool_of_${c}`, access: "read" });
    }
  });
  afterEach(() => t.restore());

  it("derives a stable account id from the email, ignoring case and whitespace", () => {
    expect(uidFromEmail(" bob@example.com ")).toBe(BOB);
    expect(ALICE).not.toBe(BOB);
    expect(ALICE).toMatch(/^[a-f0-9]{20}$/);
  });

  it("gives each account only its own machines and tool catalog", async () => {
    const a = await alice.listMachines();
    const b = await bob.listMachines();
    expect(a).toHaveLength(1);
    expect(a[0].servers[0].tools.map((x) => x.name)).toEqual(["tool_of_A"]);
    expect(a[0].meta.connectionId).toBe("conn-A");
    expect(b[0].servers[0].tools.map((x) => x.name)).toEqual(["tool_of_B"]);
    expect((await alice.getMachine("mini"))?.keys[0].kid).toBe("kid-A");
  });

  it("gives each account only its own agents and rules", async () => {
    expect((await alice.getAgent("coach"))?.rules.map((r) => r.tool)).toEqual(["mini.notes.tool_of_A"]);
    expect((await bob.getAgent("coach"))?.rules.map((r) => r.tool)).toEqual(["mini.notes.tool_of_B"]);
    await alice.putAgent({ id: "onlyalice", enabled: true, tokenVersion: 1, ratePerMinute: 1, ratePerDay: 1, maxArgBytes: 1, maxResultBytes: 1, callTimeoutMs: 1, createdAt: 0 });
    expect(await bob.getAgent("onlyalice")).toBeNull();
    expect((await bob.listAgents()).map((x) => x.id)).toEqual(["coach"]);
  });

  it("does not let a machine in one account answer a call made in another", async () => {
    await alice.createCall("call-1", "mini", "owner");
    // Bob's "mini" tries to ack and complete Alice's call id.
    await bob.ackCall("call-1", "mini");
    expect(await bob.completeCall("call-1", "mini", { resultJson: '{"content":[{"type":"text","text":"forged"}]}' })).toBe(false);
    expect(await bob.completeCall("call-1", "mini", { error: { code: "tool_error", message: "x" } })).toBe(false);
    expect((await alice.getCall("call-1"))?.status).toBe("pending");
    expect(await alice.readResult("call-1")).toBe("");
    // Alice's own machine can.
    expect(await alice.completeCall("call-1", "mini", { resultJson: '{"content":[]}' })).toBe(true);
    expect((await alice.getCall("call-1"))?.status).toBe("done");
  });

  it("records which account a connection belongs to, and a disconnect only touches that account", async () => {
    expect(await root.connection("conn-A")).toMatchObject({ uid: ALICE, machine: "mini" });
    expect(await root.connection("conn-B")).toMatchObject({ uid: BOB, machine: "mini" });
    await root.unbindConnection("conn-B");
    expect((await alice.getMachine("mini"))?.connectionId).toBe("conn-A");
    expect((await bob.getMachine("mini"))?.connectionId).toBeUndefined();
  });

  it("keeps rate limits and audit trails per account", async () => {
    expect(await alice.takeRate("coach", "M#1", 1, 60)).toBe(true);
    expect(await alice.takeRate("coach", "M#1", 1, 60)).toBe(false);
    expect(await bob.takeRate("coach", "M#1", 1, 60)).toBe(true);
    const ts = Date.UTC(2026, 10, 15, 12);
    await alice.putAudit({ pk: "ignored", sk: "s1", ttl: 1, ts, callId: "c", agent: "owner", tool: "mini.notes.tool_of_A", outcome: "ok", argsHash: "h", argBytes: 1, resultBytes: 1, latencyMs: 1, tokenKind: "oauth" });
    expect(await alice.readAudit("2026-11-15", 10)).toHaveLength(1);
    expect(await bob.readAudit("2026-11-15", 10)).toHaveLength(0);
  });

  it("refuses to touch account data through a store that is not bound to an account", async () => {
    await expect(root.listMachines()).rejects.toThrow(/not bound/);
    await expect(root.getAgent("coach")).rejects.toThrow(/not bound/);
    expect(() => root.forTenant("../x")).toThrow(/invalid account/);
  });
});

describe("account API", () => {
  let t: ReturnType<typeof fakeTable>;
  let root: Store;
  beforeEach(() => {
    t = fakeTable();
    root = new Store(t.ddb, "table");
  });
  afterEach(() => t.restore());
  const call = (email: string, method: string, path: string, body = "") => handleAccount({ method, path, body, email }, root, () => 5_000);
  const jwkA = JSON.stringify({ jwk: JWK("A") });

  it("registers this Mac under the caller's account and lists it", async () => {
    const r = await call("alice@example.com", "PUT", "/api/machines/mini", jwkA);
    expect(JSON.parse(r.body)).toEqual({ uid: ALICE, machine: "mini", kid: kidFor("A".repeat(43)) });
    const list = JSON.parse((await call("alice@example.com", "GET", "/api/machines")).body);
    expect(list.machines).toEqual([{ machine: "mini", enabled: true, connected: false, lastSeen: null, agentVersion: null, kids: [kidFor("A".repeat(43))], servers: [] }]);
    expect(JSON.parse((await call("alice@example.com", "GET", "/api/me")).body)).toEqual({ email: "alice@example.com", uid: ALICE });
  });

  it("never shows or changes another account's machines", async () => {
    await call("alice@example.com", "PUT", "/api/machines/mini", jwkA);
    expect(JSON.parse((await call("bob@example.com", "GET", "/api/machines")).body).machines).toEqual([]);
    expect((await call("bob@example.com", "DELETE", "/api/machines/mini")).statusCode).toBe(404);
    // Bob registering his own "mini" does not replace Alice's key.
    await call("bob@example.com", "PUT", "/api/machines/mini", JSON.stringify({ jwk: JWK("B") }));
    expect((await root.forTenant(ALICE).getMachine("mini"))?.keys[0].jwk.x).toBe("A".repeat(43));
    expect((await root.forTenant(BOB).getMachine("mini"))?.keys[0].jwk.x).toBe("B".repeat(43));
  });

  it("puts every Mac a user signs in from into the same account", async () => {
    await call("alice@example.com", "PUT", "/api/machines/mini", jwkA);
    await call("Alice@Example.com", "PUT", "/api/machines/air", JSON.stringify({ jwk: JWK("C") }));
    const names = JSON.parse((await call("alice@example.com", "GET", "/api/machines")).body).machines.map((m: any) => m.machine);
    expect(names.sort()).toEqual(["air", "mini"]);
  });

  it("removes a machine with its catalog", async () => {
    await call("alice@example.com", "PUT", "/api/machines/mini", jwkA);
    const s = root.forTenant(ALICE);
    await s.bindConnection("mini", "c1", "k");
    await s.replaceServers("mini", "c1", "0.2.0", [{ name: "notes", status: "up", tools: [] }]);
    expect((await call("alice@example.com", "DELETE", "/api/machines/mini")).statusCode).toBe(200);
    expect(await s.listMachines()).toEqual([]);
  });

  it("rejects private keys, bad names and bodies, and enforces the machine limit", async () => {
    expect((await call("a@example.com", "PUT", "/api/machines/mini", JSON.stringify({ jwk: { ...JWK("A"), d: "secret" } }))).statusCode).toBe(400);
    expect((await call("a@example.com", "PUT", "/api/machines/Mini!", jwkA)).statusCode).toBe(400);
    expect((await call("a@example.com", "PUT", "/api/machines/mini", "nope")).statusCode).toBe(400);
    for (let i = 0; i < 10; i++) expect((await call("a@example.com", "PUT", `/api/machines/m${i}`, jwkA)).statusCode).toBe(200);
    const over = await call("a@example.com", "PUT", "/api/machines/m10", jwkA);
    expect([over.statusCode, JSON.parse(over.body).error]).toEqual([409, "machine_limit"]);
    // Re-registering an existing machine is still allowed at the limit.
    expect((await call("a@example.com", "PUT", "/api/machines/m3", jwkA)).statusCode).toBe(200);
  });
});
