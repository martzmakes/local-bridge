// infra/test/oauth/refresh-tokens.test.ts
// The macrovault strand bug (2026-05-18), ported: MCP connectors fire
// concurrent/retried refresh_token requests. Naive delete-on-use rotation
// lets the first request win and strands every duplicate with invalid_grant —
// the connector then re-presents a dead token forever ("Connection has
// expired. You can reconnect to re-authenticate", and reconnecting loops).
// The module under test claims rotation with a conditional write and serves
// the SAME successor to every refresh inside a 60s grace window.
import {
  GetCommand,
  PutCommand,
  DeleteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  issueRefreshToken,
  consumeRefreshToken,
  hashToken,
  REFRESH_REUSE_GRACE_MS,
  DocClient,
} from "../../lib/lambdas/oauth/refresh-tokens";

// In-memory DynamoDB fake honoring the subset the module uses, including
// ConditionExpression "attribute_not_exists(consumedAt)".
function fakeDdb() {
  const rows = new Map<string, Record<string, unknown>>();
  const client: DocClient = {
    async send(cmd: unknown) {
      const c = cmd as { input: Record<string, any>; constructor: unknown };
      const input = c.input;
      const keyOf = (k: { pk: string; sk: string }) => `${k.pk}|${k.sk}`;
      if (cmd instanceof GetCommand) {
        return { Item: rows.get(keyOf(input.Key)) };
      }
      if (cmd instanceof PutCommand) {
        rows.set(keyOf(input.Item), { ...input.Item });
        return {};
      }
      if (cmd instanceof DeleteCommand) {
        rows.delete(keyOf(input.Key));
        return {};
      }
      if (cmd instanceof UpdateCommand) {
        const row = rows.get(keyOf(input.Key));
        if (!row || row.consumedAt !== undefined) {
          const err = new Error("conditional check failed");
          err.name = "ConditionalCheckFailedException";
          throw err;
        }
        row.consumedAt = input.ExpressionAttributeValues[":now"];
        row.successorEnc = input.ExpressionAttributeValues[":succ"];
        row.ttl = input.ExpressionAttributeValues[":grace"];
        return {};
      }
      throw new Error("unhandled command");
    },
  };
  return { client, rows };
}

const TABLE = "OauthTable";
const IDENTITY = {
  email: "u@example.com",
  clientId: "c-1",
  scope: "mcp:read mcp:tools",
};

it("stores only a hash of the token; row holds no usable secret", async () => {
  const { client, rows } = fakeDdb();
  const token = await issueRefreshToken(client, TABLE, IDENTITY);
  expect(rows.has(`REFRESH#${hashToken(token)}|REFRESH`)).toBe(true);
  const dump = JSON.stringify([...rows.values()]);
  expect(dump).not.toContain(token);
});

it("first use rotates: returns identity + a new successor, keeps the row in grace", async () => {
  const { client, rows } = fakeDdb();
  const token = await issueRefreshToken(client, TABLE, IDENTITY);
  const out = await consumeRefreshToken(client, TABLE, token);
  expect(out).toMatchObject(IDENTITY);
  expect(out!.rotatedRefreshToken).not.toBe(token);
  // Old row kept (grace), successor row exists, neither leaks the successor raw.
  const oldRow = rows.get(`REFRESH#${hashToken(token)}|REFRESH`)!;
  expect(oldRow.consumedAt).toBeDefined();
  expect(
    rows.has(`REFRESH#${hashToken(out!.rotatedRefreshToken)}|REFRESH`)
  ).toBe(true);
  expect(JSON.stringify([...rows.values()])).not.toContain(
    out!.rotatedRefreshToken
  );
});

it("concurrent/retried refreshes inside the grace window all get the SAME successor", async () => {
  const { client } = fakeDdb();
  const token = await issueRefreshToken(client, TABLE, IDENTITY);
  const [a, b, c] = await Promise.all([
    consumeRefreshToken(client, TABLE, token),
    consumeRefreshToken(client, TABLE, token),
    consumeRefreshToken(client, TABLE, token),
  ]);
  expect(a && b && c).toBeTruthy();
  expect(new Set([a, b, c].map((r) => r!.rotatedRefreshToken)).size).toBe(1);
});

it("reuse after the grace window is rejected (token retired)", async () => {
  const { client, rows } = fakeDdb();
  const token = await issueRefreshToken(client, TABLE, IDENTITY);
  await consumeRefreshToken(client, TABLE, token);
  const row = rows.get(`REFRESH#${hashToken(token)}|REFRESH`)!;
  row.consumedAt = Date.now() - REFRESH_REUSE_GRACE_MS - 1;
  expect(await consumeRefreshToken(client, TABLE, token)).toBeNull();
});

it("unknown and expired tokens are rejected", async () => {
  const { client, rows } = fakeDdb();
  expect(await consumeRefreshToken(client, TABLE, "nope")).toBeNull();
  const token = await issueRefreshToken(client, TABLE, IDENTITY);
  rows.get(`REFRESH#${hashToken(token)}|REFRESH`)!.ttl =
    Math.floor(Date.now() / 1000) - 10;
  expect(await consumeRefreshToken(client, TABLE, token)).toBeNull();
});
