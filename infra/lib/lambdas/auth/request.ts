import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import { PutCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import { sendMagicLinkEmail } from "./lib/email";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const MAGIC_LINK_TOKENS_TABLE = process.env.MAGIC_LINK_TOKENS_TABLE!;
const VERIFY_BASE_URL = process.env.VERIFY_BASE_URL!;
const WAITLIST_TABLE = process.env.WAITLIST_TABLE;
const PROJECT_SLUG = process.env.PROJECT_SLUG || "unknown";

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Allowlist gate — site is locked to the owner only.
// Override at deploy time via ALLOWED_EMAILS env var (comma-separated).
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || "operator@example.com")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

function response(statusCode: number, body: Record<string, unknown>) {
  return {
    statusCode,
    headers: {
      "content-type": "application/json",
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "content-type",
      "access-control-allow-methods": "POST,OPTIONS",
    },
    body: JSON.stringify(body),
  };
}

// The public homepage can collect interest without ever sending a sign-in link.
async function joinWaitlist(email: string, interest: unknown) {
  if (!WAITLIST_TABLE) return response(503, { error: "waitlist_unavailable" });
  try {
    await ddb.send(new PutCommand({
      TableName: WAITLIST_TABLE,
      Item: {
        email,
        prototype: PROJECT_SLUG,
        createdAt: Date.now(),
        ...(interest === "free" || interest === "plus" || interest === "self-host" ? { interest } : {}),
      },
      ConditionExpression: "attribute_not_exists(email)",
    }));
  } catch (error) {
    if ((error as { name?: string }).name !== "ConditionalCheckFailedException") {
      return response(503, { error: "waitlist_unavailable" });
    }
  }
  return response(200, { ok: true });
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  if (event.requestContext.http.method === "OPTIONS") {
    return response(204, {});
  }

  if (Buffer.byteLength(event.body || "", "utf8") > 4096) {
    return response(413, { error: "payload_too_large" });
  }
  let parsed: { email?: unknown; interest?: unknown; referrer?: unknown };
  try {
    const value: unknown = JSON.parse(event.body || "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      return response(400, { error: "invalid_json" });
    }
    parsed = value;
  } catch {
    return response(400, { error: "invalid_json" });
  }

  const email = typeof parsed.email === "string" ? parsed.email.trim().toLowerCase() : "";
  if (!email || !EMAIL_RE.test(email) || email.length > 254) {
    return response(400, { error: "invalid_email" });
  }

  if (event.rawPath === "/api/waitlist") return joinWaitlist(email, parsed.interest);

  // Non-allowlisted → waitlist. Interested visitors are captured as a demand
  // signal instead of silently dropped. Allowlisted owner email falls through
  // to magic-link. Response is identical either way — no enumeration leak.
  if (!ALLOWED_EMAILS.includes(email)) {
    if (WAITLIST_TABLE) {
      try {
        await ddb.send(
          new PutCommand({
            TableName: WAITLIST_TABLE,
            Item: {
              email,
              prototype: PROJECT_SLUG,
              createdAt: Date.now(),
              createdAtIso: new Date().toISOString(),
              referrer: typeof parsed.referrer === "string" ? parsed.referrer.slice(0, 254) : null,
            },
            // Don't overwrite an earlier signup timestamp for the same email.
            ConditionExpression: "attribute_not_exists(email)",
          })
        );
        console.log("waitlist_signup", { email, prototype: PROJECT_SLUG });
      } catch (err) {
        // ConditionalCheckFailed = already on the list; anything else we
        // swallow so the UX still shows success (don't leak storage state).
        console.log("waitlist_put_noop_or_error", {
          email,
          err: err instanceof Error ? err.name : String(err),
        });
      }
    }
    return response(200, { ok: true });
  }

  const token = randomUUID();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const ttl = nowSeconds + 15 * 60; // 15 minutes

  await ddb.send(
    new PutCommand({
      TableName: MAGIC_LINK_TOKENS_TABLE,
      Item: {
        token,
        email,
        createdAt: Date.now(),
        ttl,
      },
    })
  );

  const verifyUrl = `${VERIFY_BASE_URL}?token=${encodeURIComponent(token)}`;

  try {
    await sendMagicLinkEmail(email, verifyUrl);
  } catch (err) {
    console.error("sendMagicLinkEmail failed", err);
    // Still return ok — don't leak whether SES delivered.
  }

  // Always return ok — don't reveal whether the email exists.
  return response(200, { ok: true });
};
