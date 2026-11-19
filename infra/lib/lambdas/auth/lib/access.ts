import { createHash } from "node:crypto";
import { DynamoDBDocumentClient, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";

export function publicSignupsEnabled(): boolean {
  return process.env.PUBLIC_SIGNUPS === "1";
}

export function canSignIn(email: string): boolean {
  if (publicSignupsEnabled()) return true;
  return (process.env.ALLOWED_EMAILS ?? "").split(",").some(entry =>
    entry.trim() !== "" && entry.trim().toLowerCase() === email.toLowerCase(),
  );
}

/** Keep public email sends bounded across the web, Mac and OAuth sign-in paths. */
export async function reserveSignInEmail(
  ddb: DynamoDBDocumentClient,
  table: string,
  email: string,
): Promise<boolean> {
  if (!publicSignupsEnabled()) return true;

  const now = Math.floor(Date.now() / 1000);
  const recipient = createHash("sha256").update(email).digest("hex");
  const limits = [
    { key: recipient, period: 15 * 60, max: 3 },
    { key: "all", period: 60, max: 20 },
    { key: "all", period: 60 * 60, max: 300 },
  ];
  try {
    await ddb.send(new TransactWriteCommand({
      TransactItems: limits.map(({ key, period, max }) => ({
        Update: {
          TableName: table,
          Key: { token: "RATE#" + key + "#" + period + "#" + Math.floor(now / period) },
          UpdateExpression: "SET ttl = :ttl ADD attempts :one",
          ConditionExpression: "attribute_not_exists(attempts) OR attempts < :max",
          ExpressionAttributeValues: { ":ttl": now + 2 * period, ":one": 1, ":max": max },
        },
      })),
    }));
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === "TransactionCanceledException") return false;
    throw error;
  }
}
