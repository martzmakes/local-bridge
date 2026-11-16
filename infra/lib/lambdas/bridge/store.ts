// DynamoDB access for BridgeTable. Spec section 9.
//
//   AGENTS    / <id>#META, <id>#RULE#<tool>
//   MACHINES  / <id>#META, <id>#SERVER#<name>
//   CONN#<connectionId> / META
//   JTI#<jti> / META
//   FRAME#<connectionId>#<id> / <i>  (and DONE)
//   CALL#<callId> / META, RES#<i>
//   RATE#<agent> / M#<yyyymmddhhmm>, D#<yyyymmdd>
//   AUDIT#<yyyy-mm-dd> / <iso ts>#<callId>
//
// Agents and machines each share one partition so the MCP Lambda reads an
// agent with its rules, or the whole machine catalog, in a single Query.
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DeleteCommand,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import type { ServerInfo, ToolInfo } from "../../shared/protocol";
import { RuleSchema, type Rule } from "./policy";
import type { AuditRow } from "./audit";

export interface AgentMeta {
  id: string;
  enabled: boolean;
  description?: string;
  tokenVersion: number;
  ratePerMinute: number;
  ratePerDay: number;
  maxArgBytes: number;
  maxResultBytes: number;
  callTimeoutMs: number;
  createdAt: number;
}

export const AGENT_DEFAULTS = {
  enabled: true,
  tokenVersion: 1,
  ratePerMinute: 30,
  ratePerDay: 1000,
  maxArgBytes: 65_536,
  maxResultBytes: 262_144,
  callTimeoutMs: 20_000,
} as const;

export const HARD_MAX_RESULT_BYTES = 1_048_576;
export const HARD_MAX_CALL_TIMEOUT_MS = 25_000;

export interface DeviceKey {
  kid: string;
  jwk: { kty: "OKP"; crv: "Ed25519"; x: string };
  addedAt: number;
  /** Set on the outgoing key during a rotation. */
  expiresAt?: number;
}

export interface MachineMeta {
  id: string;
  enabled: boolean;
  keys: DeviceKey[];
  connectionId?: string;
  connectedAt?: number;
  lastSeenAt?: number;
  agentVersion?: string;
  /** Latest status per server from heartbeats; overrides the server row's status. */
  serverStatus?: Record<string, { status: "up" | "down"; error?: string }>;
}

export interface MachineServer {
  machine: string;
  name: string;
  title?: string;
  status: "up" | "down";
  error?: string;
  tools: ToolInfo[];
  updatedAt: number;
}

export interface Machine {
  meta: MachineMeta;
  servers: MachineServer[];
}

export type CallStatus = "pending" | "acked" | "done" | "error" | "abandoned";

export interface CallMeta {
  callId: string;
  machine: string;
  agent: string;
  status: CallStatus;
  ackAt?: number;
  error?: { code: string; message: string };
  chunks?: number;
  createdAt: number;
}

const RES_SLICE_BYTES = 300_000;
const SHORT_TTL_SECONDS = 300;

function isConditionalFailure(err: unknown): boolean {
  return err instanceof ConditionalCheckFailedException || (err as { name?: string })?.name === "ConditionalCheckFailedException";
}

export class Store {
  constructor(
    private ddb: DynamoDBDocumentClient,
    private table: string,
    private now: () => number = Date.now
  ) {}

  private ttl(seconds: number): number {
    return Math.floor(this.now() / 1000) + seconds;
  }

  // ---- agents -------------------------------------------------------------

  async getAgent(id: string): Promise<{ meta: AgentMeta; rules: Rule[] } | null> {
    const res = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)",
        ExpressionAttributeValues: { ":pk": "AGENTS", ":p": `${id}#` },
      })
    );
    const items = res.Items ?? [];
    const metaItem = items.find((i) => i.sk === `${id}#META`);
    if (!metaItem) return null;
    const rules: Rule[] = [];
    for (const item of items) {
      if (!String(item.sk).startsWith(`${id}#RULE#`)) continue;
      // A rule that no longer validates is skipped, which denies: fail closed.
      const parsed = RuleSchema.safeParse(item.rule);
      if (parsed.success) rules.push(parsed.data);
    }
    return { meta: metaItem.meta as AgentMeta, rules };
  }

  async listAgents(): Promise<AgentMeta[]> {
    const res = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": "AGENTS" },
      })
    );
    return (res.Items ?? []).filter((i) => String(i.sk).endsWith("#META")).map((i) => i.meta as AgentMeta);
  }

  async putAgent(meta: AgentMeta): Promise<void> {
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: { pk: "AGENTS", sk: `${meta.id}#META`, meta } }));
  }

  async putRule(agent: string, rule: Rule): Promise<void> {
    await this.ddb.send(
      new PutCommand({ TableName: this.table, Item: { pk: "AGENTS", sk: `${agent}#RULE#${rule.tool}`, rule } })
    );
  }

  async deleteRule(agent: string, tool: string): Promise<void> {
    await this.ddb.send(new DeleteCommand({ TableName: this.table, Key: { pk: "AGENTS", sk: `${agent}#RULE#${tool}` } }));
  }

  // ---- machines -----------------------------------------------------------

  async listMachines(): Promise<Machine[]> {
    const res = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": "MACHINES" },
        ConsistentRead: true,
      })
    );
    const byId = new Map<string, Machine>();
    const items = res.Items ?? [];
    for (const item of items) {
      if (String(item.sk).endsWith("#META")) {
        const meta = item.meta as MachineMeta;
        byId.set(meta.id, { meta: { ...meta, ...liveFields(item) }, servers: [] });
      }
    }
    for (const item of items) {
      if (!String(item.sk).includes("#SERVER#")) continue;
      const server = item.server as MachineServer;
      const m = byId.get(server.machine);
      if (!m) continue;
      const live = m.meta.serverStatus?.[server.name];
      m.servers.push(live ? { ...server, status: live.status, error: live.error } : server);
    }
    return [...byId.values()];
  }

  async getMachine(id: string): Promise<MachineMeta | null> {
    const res = await this.ddb.send(
      new GetCommand({ TableName: this.table, Key: { pk: "MACHINES", sk: `${id}#META` }, ConsistentRead: true })
    );
    if (!res.Item) return null;
    return { ...(res.Item.meta as MachineMeta), ...liveFields(res.Item) };
  }

  /** Creates or replaces the registration (enabled flag and keys). Live fields are kept. */
  async putMachineRegistration(id: string, enabled: boolean, keys: DeviceKey[]): Promise<void> {
    await this.ddb.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: "MACHINES", sk: `${id}#META` },
        UpdateExpression: "SET meta = :meta",
        ExpressionAttributeValues: { ":meta": { id, enabled, keys } },
      })
    );
  }

  async bindConnection(machine: string, connectionId: string, kid?: string): Promise<void> {
    const now = this.now();
    await this.ddb.send(
      new PutCommand({
        TableName: this.table,
        Item: { pk: `CONN#${connectionId}`, sk: "META", machine, kid, connectedAt: now, ttl: this.ttl(3 * 3600) },
      })
    );
    await this.ddb.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: "MACHINES", sk: `${machine}#META` },
        UpdateExpression: "SET connectionId = :c, connectedAt = :n, lastSeenAt = :n",
        ConditionExpression: "attribute_exists(meta)",
        ExpressionAttributeValues: { ":c": connectionId, ":n": now },
      })
    );
  }

  async connection(connectionId: string): Promise<{ machine: string; kid?: string } | null> {
    const res = await this.ddb.send(
      new GetCommand({ TableName: this.table, Key: { pk: `CONN#${connectionId}`, sk: "META" }, ConsistentRead: true })
    );
    if (!res.Item || typeof res.Item.machine !== "string") return null;
    return { machine: res.Item.machine, kid: res.Item.kid as string | undefined };
  }

  async connectionMachine(connectionId: string): Promise<string | null> {
    return (await this.connection(connectionId))?.machine ?? null;
  }

  /** Removes the connection. Clears the machine's connectionId only if it is still this one. */
  async unbindConnection(connectionId: string): Promise<void> {
    const machine = await this.connectionMachine(connectionId);
    await this.ddb.send(new DeleteCommand({ TableName: this.table, Key: { pk: `CONN#${connectionId}`, sk: "META" } }));
    if (!machine) return;
    try {
      await this.ddb.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: "MACHINES", sk: `${machine}#META` },
          UpdateExpression: "REMOVE connectionId",
          ConditionExpression: "connectionId = :c",
          ExpressionAttributeValues: { ":c": connectionId },
        })
      );
    } catch (err) {
      if (!isConditionalFailure(err)) throw err; // a newer connection already took over
    }
  }

  async heartbeat(machine: string, connectionId: string, serverStatus: MachineMeta["serverStatus"]): Promise<void> {
    try {
      await this.ddb.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: "MACHINES", sk: `${machine}#META` },
          UpdateExpression: "SET lastSeenAt = :n, serverStatus = :s",
          ConditionExpression: "connectionId = :c",
          ExpressionAttributeValues: { ":n": this.now(), ":s": serverStatus ?? {}, ":c": connectionId },
        })
      );
    } catch (err) {
      if (!isConditionalFailure(err)) throw err; // heartbeat from a superseded connection
    }
  }

  /** Replaces a machine's catalog with what its hello announced. */
  async replaceServers(machine: string, connectionId: string, agentVersion: string, servers: ServerInfo[]): Promise<void> {
    const now = this.now();
    const existing = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)",
        ExpressionAttributeValues: { ":pk": "MACHINES", ":p": `${machine}#SERVER#` },
        ProjectionExpression: "sk",
      })
    );
    const keep = new Set(servers.map((s) => `${machine}#SERVER#${s.name}`));
    for (const item of existing.Items ?? []) {
      if (!keep.has(item.sk as string)) {
        await this.ddb.send(new DeleteCommand({ TableName: this.table, Key: { pk: "MACHINES", sk: item.sk } }));
      }
    }
    for (const s of servers) {
      const server: MachineServer = { machine, name: s.name, title: s.title, status: s.status, error: s.error, tools: s.tools, updatedAt: now };
      await this.ddb.send(
        new PutCommand({ TableName: this.table, Item: { pk: "MACHINES", sk: `${machine}#SERVER#${s.name}`, server } })
      );
    }
    const serverStatus = Object.fromEntries(servers.map((s) => [s.name, { status: s.status, ...(s.error ? { error: s.error } : {}) }]));
    await this.ddb.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { pk: "MACHINES", sk: `${machine}#META` },
        UpdateExpression: "SET lastSeenAt = :n, agentVersion = :v, serverStatus = :s, connectionId = :c",
        ConditionExpression: "attribute_exists(meta)",
        ExpressionAttributeValues: { ":n": now, ":v": agentVersion, ":s": serverStatus, ":c": connectionId },
      })
    );
  }

  /** True if this jti has not been seen before. */
  async claimJti(jti: string): Promise<boolean> {
    try {
      await this.ddb.send(
        new PutCommand({
          TableName: this.table,
          Item: { pk: `JTI#${jti}`, sk: "META", ttl: this.ttl(SHORT_TTL_SECONDS) },
          ConditionExpression: "attribute_not_exists(pk)",
        })
      );
      return true;
    } catch (err) {
      if (isConditionalFailure(err)) return false;
      throw err;
    }
  }

  // ---- frames -------------------------------------------------------------

  /**
   * Stores one slice of a multi-frame message. Returns the ordered slices when
   * this call is the one that completes the set (exactly one caller gets them),
   * otherwise null.
   */
  async addFrame(connectionId: string, id: string, i: number, n: number, d: string): Promise<string[] | null> {
    const pk = `FRAME#${connectionId}#${id}`;
    await this.ddb.send(
      new PutCommand({ TableName: this.table, Item: { pk, sk: String(i).padStart(4, "0"), d, ttl: this.ttl(SHORT_TTL_SECONDS) } })
    );
    const res = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "pk = :pk AND sk < :done",
        ExpressionAttributeValues: { ":pk": pk, ":done": "DONE" },
        ConsistentRead: true,
      })
    );
    const items = res.Items ?? [];
    if (items.length < n) return null;
    try {
      await this.ddb.send(
        new PutCommand({
          TableName: this.table,
          Item: { pk, sk: "DONE", ttl: this.ttl(SHORT_TTL_SECONDS) },
          ConditionExpression: "attribute_not_exists(pk)",
        })
      );
    } catch (err) {
      if (isConditionalFailure(err)) return null; // another invocation assembled it
      throw err;
    }
    return items.sort((a, b) => String(a.sk).localeCompare(String(b.sk))).map((it) => it.d as string);
  }

  // ---- calls --------------------------------------------------------------

  async createCall(callId: string, machine: string, agent: string): Promise<void> {
    const meta: CallMeta = { callId, machine, agent, status: "pending", createdAt: this.now() };
    await this.ddb.send(
      new PutCommand({ TableName: this.table, Item: { pk: `CALL#${callId}`, sk: "META", ...meta, ttl: this.ttl(SHORT_TTL_SECONDS) } })
    );
  }

  async getCall(callId: string): Promise<CallMeta | null> {
    const res = await this.ddb.send(
      new GetCommand({ TableName: this.table, Key: { pk: `CALL#${callId}`, sk: "META" }, ConsistentRead: true })
    );
    return (res.Item as CallMeta | undefined) ?? null;
  }

  async ackCall(callId: string, machine: string): Promise<void> {
    await this.transition(callId, machine, ["pending"], "SET #s = :to, ackAt = :n", { ":to": "acked", ":n": this.now() });
  }

  /** Stores the outcome. Returns false if the call was not waiting for this machine (late, wrong machine, unknown). */
  async completeCall(callId: string, machine: string, outcome: { resultJson: string } | { error: { code: string; message: string } }): Promise<boolean> {
    if ("error" in outcome) {
      return this.transition(callId, machine, ["pending", "acked"], "SET #s = :to, #e = :e", { ":to": "error", ":e": outcome.error }, { "#e": "error" });
    }
    // Refuse to store anything for a call that is not waiting on this machine.
    const call = await this.getCall(callId);
    if (!call || call.machine !== machine || (call.status !== "pending" && call.status !== "acked")) return false;
    const bytes = Buffer.from(outcome.resultJson, "utf8");
    const chunks = Math.max(1, Math.ceil(bytes.length / RES_SLICE_BYTES));
    for (let i = 0; i < chunks; i++) {
      await this.ddb.send(
        new PutCommand({
          TableName: this.table,
          Item: {
            pk: `CALL#${callId}`,
            sk: `RES#${String(i).padStart(3, "0")}`,
            d: bytes.subarray(i * RES_SLICE_BYTES, (i + 1) * RES_SLICE_BYTES),
            ttl: this.ttl(SHORT_TTL_SECONDS),
          },
        })
      );
    }
    return this.transition(callId, machine, ["pending", "acked"], "SET #s = :to, chunks = :c", { ":to": "done", ":c": chunks });
  }

  /** The cloud gave up waiting. A result arriving after this is dropped. */
  async abandonCall(callId: string, machine: string): Promise<void> {
    await this.transition(callId, machine, ["pending", "acked"], "SET #s = :to", { ":to": "abandoned" });
  }

  private async transition(
    callId: string,
    machine: string,
    from: CallStatus[],
    update: string,
    values: Record<string, unknown>,
    names: Record<string, string> = {}
  ): Promise<boolean> {
    const fromKeys = from.map((_, i) => `:f${i}`);
    try {
      await this.ddb.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: `CALL#${callId}`, sk: "META" },
          UpdateExpression: update,
          ConditionExpression: `machine = :m AND #s IN (${fromKeys.join(", ")})`,
          ExpressionAttributeNames: { "#s": "status", ...names },
          ExpressionAttributeValues: { ...values, ":m": machine, ...Object.fromEntries(from.map((f, i) => [`:f${i}`, f])) },
        })
      );
      return true;
    } catch (err) {
      if (isConditionalFailure(err)) return false;
      throw err;
    }
  }

  async readResult(callId: string): Promise<string> {
    const res = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)",
        ExpressionAttributeValues: { ":pk": `CALL#${callId}`, ":p": "RES#" },
        ConsistentRead: true,
      })
    );
    const parts = (res.Items ?? []).map((i) => Buffer.from(i.d as Uint8Array));
    return Buffer.concat(parts).toString("utf8");
  }

  /** Deletes a finished call's rows right away instead of waiting for the TTL. */
  async deleteCall(callId: string, chunks: number): Promise<void> {
    const keys = [{ pk: `CALL#${callId}`, sk: "META" }];
    for (let i = 0; i < chunks; i++) keys.push({ pk: `CALL#${callId}`, sk: `RES#${String(i).padStart(3, "0")}` });
    for (let i = 0; i < keys.length; i += 25) {
      await this.ddb.send(
        new BatchWriteCommand({
          RequestItems: { [this.table]: keys.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) },
        })
      );
    }
  }

  // ---- rate limits --------------------------------------------------------

  /** Increments the counter unless it has reached the limit. Returns false when limited. */
  async takeRate(agent: string, window: string, limit: number, ttlSeconds: number): Promise<boolean> {
    try {
      await this.ddb.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { pk: `RATE#${agent}`, sk: window },
          UpdateExpression: "ADD n :one SET #t = :ttl",
          ConditionExpression: "attribute_not_exists(n) OR n < :limit",
          ExpressionAttributeNames: { "#t": "ttl" },
          ExpressionAttributeValues: { ":one": 1, ":limit": limit, ":ttl": this.ttl(ttlSeconds) },
        })
      );
      return true;
    } catch (err) {
      if (isConditionalFailure(err)) return false;
      throw err;
    }
  }

  // ---- audit --------------------------------------------------------------

  async putAudit(row: AuditRow): Promise<void> {
    await this.ddb.send(new PutCommand({ TableName: this.table, Item: row }));
  }

  async readAudit(day: string, limit: number): Promise<AuditRow[]> {
    const res = await this.ddb.send(
      new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: "pk = :pk",
        ExpressionAttributeValues: { ":pk": `AUDIT#${day}` },
        ScanIndexForward: false,
        Limit: limit,
      })
    );
    return (res.Items ?? []) as AuditRow[];
  }
}

function liveFields(item: Record<string, unknown>): Partial<MachineMeta> {
  const out: Partial<MachineMeta> = {};
  if (typeof item.connectionId === "string") out.connectionId = item.connectionId;
  if (typeof item.connectedAt === "number") out.connectedAt = item.connectedAt;
  if (typeof item.lastSeenAt === "number") out.lastSeenAt = item.lastSeenAt;
  if (typeof item.agentVersion === "string") out.agentVersion = item.agentVersion;
  if (item.serverStatus && typeof item.serverStatus === "object") out.serverStatus = item.serverStatus as MachineMeta["serverStatus"];
  return out;
}
