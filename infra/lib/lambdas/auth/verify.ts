import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  GetCommand,
  UpdateCommand,
  PutCommand,
  DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { mintJwt } from "./lib/jwt";
import { canSignIn } from "./lib/access";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const MAGIC_LINK_TOKENS_TABLE = process.env.MAGIC_LINK_TOKENS_TABLE!;
const USERS_TABLE = process.env.USERS_TABLE!;
const SITE_URL = process.env.SITE_URL!;
const PROJECT_SLUG = process.env.PROJECT_SLUG!;
// OAUTH_TABLE is optional — only needed when the MCP/OAuth block is wired in
// `infra-stack.ts`. If you delete the OAuth handler, leave this — the
// fallthrough below is harmless when the env var is empty.
const OAUTH_TABLE = process.env.OAUTH_TABLE || "";

const SSO_COOKIE_NAME = `${PROJECT_SLUG}_sso`;
const SSO_COOKIE_MAX_AGE = 60 * 60 * 24 * 30; // 30 days — matches JWT TTL

// Build a Set-Cookie value for the SSO session. The cookie holds the user's
// JWT; presence on /oauth/authorize lets us skip the email loop for users
// who already signed in. SameSite=Lax so the cookie rides top-level
// navigation from the MCP client → /oauth/authorize.
function buildSsoCookie(jwt: string): string {
  return [
    `${SSO_COOKIE_NAME}=${encodeURIComponent(jwt)}`,
    `Max-Age=${SSO_COOKIE_MAX_AGE}`,
    "Path=/",
    "Secure",
    "HttpOnly",
    "SameSite=Lax",
  ].join("; ");
}

function htmlResponse(
  statusCode: number,
  html: string,
  extraHeaders: Record<string, string> = {}
) {
  return {
    statusCode,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...extraHeaders,
    },
    body: html,
  };
}

const COMMON_STYLES = `
  body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#07090C;color:#EEF1F6;font-family:'General Sans',-apple-system,Segoe UI,Roboto,sans-serif;padding:24px;letter-spacing:-0.01em}
  .card{max-width:420px;text-align:center;background:#11151C;border:1px solid rgba(255,255,255,0.1);border-radius:10px;padding:32px}
  .eyebrow{font-family:'JetBrains Mono',ui-monospace,Menlo,monospace;font-size:11px;letter-spacing:0.08em;color:#8892A0;text-transform:uppercase;margin:0 0 12px}
  h1{margin:0 0 12px;font-size:24px;font-weight:600;letter-spacing:-0.02em}
  p{line-height:1.5;color:#B8C0CC;font-size:15px;margin:0 0 16px}
  a.btn{display:inline-block;background:#3B82FF;color:#fff;padding:10px 20px;border-radius:6px;text-decoration:none;font-weight:500;font-size:14px;margin-top:8px}
`;

function errorPage(eyebrow: string, title: string, message: string) {
  return htmlResponse(
    400,
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${title}</title><style>${COMMON_STYLES} h1{color:#F26D6D}</style></head><body><div class="card"><div class="eyebrow">${eyebrow}</div><h1>${title}</h1><p>${message}</p></div></body></html>`
  );
}

function successPage(jwt: string) {
  const webLink = `${SITE_URL}/auth/complete?jwt=${encodeURIComponent(jwt)}`;
  return htmlResponse(
    200,
    `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Signed in</title><style>${COMMON_STYLES} h1{color:#EEF1F6}</style><script>window.location.replace(${JSON.stringify(
      webLink
    )});</script></head><body><div class="card"><div class="eyebrow">SIGN IN</div><h1>You're signed in</h1><p>Returning you to the app…</p><a class="btn" href="${webLink}">Open the app</a></div></body></html>`,
    { "set-cookie": buildSsoCookie(jwt) }
  );
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const token = event.queryStringParameters?.token;
  if (!token) {
    return errorPage("LINK INVALID", "Link invalid", "This sign-in link is missing its token.");
  }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(token)) {
    return errorPage("LINK INVALID", "Link invalid", "Request a new sign-in link.");
  }

  // Delete and read in one operation so concurrent clicks cannot reuse a link.
  const tokenRow = await ddb.send(
    new DeleteCommand({
      TableName: MAGIC_LINK_TOKENS_TABLE,
      Key: { token },
      ReturnValues: "ALL_OLD",
    })
  );

  if (typeof tokenRow.Attributes?.email !== "string") {
    return errorPage(
      "LINK EXPIRED",
      "Link expired",
      "This sign-in link has already been used or has expired. Request a new one."
    );
  }

  const nowSeconds = Math.floor(Date.now() / 1000);
  if (tokenRow.Attributes.ttl && tokenRow.Attributes.ttl < nowSeconds) {
    return errorPage(
      "LINK EXPIRED",
      "Link expired",
      "This sign-in link has expired. Request a new one."
    );
  }

  const email = tokenRow.Attributes.email;
  // OAuth handoff: when the magic-link was minted by /oauth/email, the row
  // carries an `oauthCode`. We approve that auth request and 302 to the
  // client's callback instead of the normal app return.
  const oauthCode = (tokenRow.Attributes.oauthCode as string | undefined) || "";

  // Recheck access in case the deployment switched back to invitations.
  if (!canSignIn(email)) {
    console.log("verify_blocked_non_allowlisted");
    return errorPage(
      "ACCESS RESTRICTED",
      "Access restricted",
      "This prototype is currently limited to its owner. Join the waitlist to be notified when it opens up."
    );
  }

  // Upsert user record.
  const now = Date.now();
  await ddb.send(
    new UpdateCommand({
      TableName: USERS_TABLE,
      Key: { email },
      UpdateExpression:
        "SET lastLoginAt = :now, createdAt = if_not_exists(createdAt, :now), ownedEntitlements = if_not_exists(ownedEntitlements, :empty)",
      ExpressionAttributeValues: {
        ":now": now,
        ":empty": [] as string[],
      },
    })
  );

  // OAuth-flow handoff (only if the OAuth block is deployed).
  if (oauthCode && OAUTH_TABLE) {
    const authRow = await ddb.send(
      new GetCommand({
        TableName: OAUTH_TABLE,
        Key: { pk: `AUTH#${oauthCode}`, sk: "AUTH" },
      })
    );
    const authRequest = authRow.Item as
      | {
          authCode: string;
          redirectUri: string;
          state?: string;
          expiresAt: number;
          codeChallenge: string;
          codeChallengeMethod: string;
          clientId: string;
          scope: string;
          createdAt: number;
        }
      | undefined;
    if (authRequest && authRequest.expiresAt >= Date.now()) {
      await ddb.send(
        new PutCommand({
          TableName: OAUTH_TABLE,
          Item: {
            pk: `AUTH#${oauthCode}`,
            sk: "AUTH",
            ...authRequest,
            approved: true,
            email,
            ttl: Math.floor(authRequest.expiresAt / 1000),
          },
        })
      );
      const callback = new URL(authRequest.redirectUri);
      callback.searchParams.set("code", oauthCode);
      if (authRequest.state) callback.searchParams.set("state", authRequest.state);
      const ssoJwt = await mintJwt(email);
      return {
        statusCode: 302,
        headers: {
          location: callback.toString(),
          "cache-control": "no-store",
          "set-cookie": buildSsoCookie(ssoJwt),
        },
        body: "",
      };
    }
  }

  const jwt = await mintJwt(email);
  return successPage(jwt);
};
