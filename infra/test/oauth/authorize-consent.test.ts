// infra/test/oauth/authorize-consent.test.ts
//
// Authorization-request CSRF / confused deputy. /oauth/register is open and
// anonymous (RFC 7591), so anyone can register a client whose redirect_uri
// they control. The SSO fast path used to see a valid session cookie on
// GET /oauth/authorize and immediately 302 an APPROVED auth code to that
// redirect_uri — meaning a signed-in user who merely *clicked an attacker's
// link* handed over a working MCP token, having agreed to nothing. PKCE does
// not help: the attacker generates their own verifier.
//
// The control is an explicit consent screen. These tests pin that
//   (a) the SSO path renders consent instead of redirecting,
//   (b) approval requires a session-cookie-bound CSRF token,
//   (c) denial reports access_denied and burns the code.
//
// SYNTHETIC ONLY: fabricated client ids, URIs, emails, and PKCE values.
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2 } from "aws-lambda";
import { createHash } from "crypto";

process.env.OAUTH_TABLE = "test-oauth";
process.env.MAGIC_LINK_TOKENS_TABLE = "test-magic-links";
process.env.PROJECT_SLUG = "testproto";
process.env.SITE_URL = "https://testproto.example.com";
process.env.JWT_SECRET_NAME = "/test/jwt-secret";
process.env.DOMAIN = "testproto.example.com";
process.env.SES_FROM_ADDRESS = "noreply@testproto.example.com";
process.env.ALLOWED_EMAILS = "owner@example.com";

const SSO_JWT = "synthetic.session.jwt";
const OWNER = "owner@example.com";

jest.mock("../../lib/lambdas/auth/lib/jwt", () => ({
  mintJwt: jest.fn(async () => "synthetic.access.jwt"),
  verifyJwt: jest.fn(async (token: string) => {
    if (token !== SSO_JWT) throw new Error("bad token");
    return { email: OWNER };
  }),
}));

const ddbMock = mockClient(DynamoDBDocumentClient);

import { handler } from "../../lib/lambdas/oauth/handler";

const CLIENT_ID = "client-synthetic-1";
const REGISTERED_URI = "https://claude.ai/api/mcp/auth_callback";

function base64url(buf: Buffer) {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

/** Mirrors the handler's cookie-bound consent token derivation. */
function expectedCsrf(authCode: string) {
  return base64url(
    createHash("sha256").update(`${SSO_JWT}:${authCode}:consent`).digest()
  );
}

function authorizeEvent(cookies?: string[]): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    rawPath: "/oauth/authorize",
    rawQueryString: "",
    headers: {},
    cookies,
    queryStringParameters: {
      client_id: CLIENT_ID,
      redirect_uri: REGISTERED_URI,
      response_type: "code",
      code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
      code_challenge_method: "S256",
      state: "synthetic-state",
    },
    requestContext: { http: { method: "GET" } },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

function consentEvent(
  body: Record<string, string>,
  cookies?: string[]
): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    rawPath: "/oauth/consent",
    rawQueryString: "",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    cookies,
    body: new URLSearchParams(body).toString(),
    requestContext: { http: { method: "POST" } },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

const AUTH_CODE = "synthetic-auth-code";

function seed(authRequest?: Record<string, unknown>) {
  ddbMock.reset();
  ddbMock.on(GetCommand).callsFake((input) => {
    if (input.Key?.pk === `CLIENT#${CLIENT_ID}`) {
      return {
        Item: {
          clientId: CLIENT_ID,
          clientName: "Synthetic Client",
          redirectUris: [REGISTERED_URI],
          createdAt: Date.now(),
        },
      };
    }
    if (input.Key?.pk === `AUTH#${AUTH_CODE}` && authRequest) {
      return { Item: authRequest };
    }
    return {};
  });
  ddbMock.on(PutCommand).resolves({});
  ddbMock.on(DeleteCommand).resolves({});
}

const pendingAuthRequest = () => ({
  pk: `AUTH#${AUTH_CODE}`,
  authCode: AUTH_CODE,
  clientId: CLIENT_ID,
  redirectUri: REGISTERED_URI,
  codeChallenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  codeChallengeMethod: "S256",
  state: "synthetic-state",
  scope: "mcp:read mcp:tools",
  approved: false,
  expiresAt: Date.now() + 600_000,
  createdAt: Date.now(),
});

/** AuthRequest rows written with approved:true. */
function approvedPuts() {
  return ddbMock
    .commandCalls(PutCommand)
    .map((c) => c.args[0].input)
    .filter((i: any) => i.Item?.approved === true);
}

describe("oauth authorize — SSO path requires explicit consent", () => {
  it("renders a consent screen instead of silently redirecting the code", async () => {
    seed();
    const res: any = await handler(
      authorizeEvent([`testproto_sso=${SSO_JWT}`]),
      {} as any,
      {} as any
    );

    expect(res.statusCode).toBe(200);
    expect(res.headers["content-type"]).toMatch(/text\/html/);
    expect(res.body).toMatch(/action="\/oauth\/consent"/);
    expect(res.body).toMatch(/name="decision" value="approve"/);
    expect(res.body).toMatch(/name="decision" value="deny"/);
    expect(res.body).toMatch(/name="csrf"/);
    // The whole point: nothing is approved just by loading the page.
    expect(approvedPuts()).toHaveLength(0);
  });

  it("falls through to the sign-in page when the cookie is not valid", async () => {
    seed();
    const res: any = await handler(
      authorizeEvent(["testproto_sso=stale-cookie"]),
      {} as any,
      {} as any
    );

    expect(res.statusCode).toBe(200);
    expect(res.body).not.toMatch(/action="\/oauth\/consent"/);
    expect(approvedPuts()).toHaveLength(0);
  });
});

describe("oauth consent — POST /oauth/consent", () => {
  it("approves and redirects with the code when session + CSRF token match", async () => {
    seed(pendingAuthRequest());
    const res: any = await handler(
      consentEvent(
        {
          oauth_code: AUTH_CODE,
          csrf: expectedCsrf(AUTH_CODE),
          decision: "approve",
        },
        [`testproto_sso=${SSO_JWT}`]
      ),
      {} as any,
      {} as any
    );

    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location);
    expect(loc.origin + loc.pathname).toBe(REGISTERED_URI);
    expect(loc.searchParams.get("code")).toBe(AUTH_CODE);
    expect(loc.searchParams.get("state")).toBe("synthetic-state");
    expect(approvedPuts()).toHaveLength(1);
  });

  it("rejects a forged CSRF token and approves nothing", async () => {
    seed(pendingAuthRequest());
    const res: any = await handler(
      consentEvent(
        { oauth_code: AUTH_CODE, csrf: "forged-token", decision: "approve" },
        [`testproto_sso=${SSO_JWT}`]
      ),
      {} as any,
      {} as any
    );

    expect(res.statusCode).toBe(403);
    expect(approvedPuts()).toHaveLength(0);
  });

  it("rejects a POST with no session cookie", async () => {
    seed(pendingAuthRequest());
    const res: any = await handler(
      consentEvent({
        oauth_code: AUTH_CODE,
        csrf: expectedCsrf(AUTH_CODE),
        decision: "approve",
      }),
      {} as any,
      {} as any
    );

    expect(res.statusCode).toBe(401);
    expect(approvedPuts()).toHaveLength(0);
  });

  it("reports access_denied and burns the code on Deny", async () => {
    seed(pendingAuthRequest());
    const res: any = await handler(
      consentEvent(
        {
          oauth_code: AUTH_CODE,
          csrf: expectedCsrf(AUTH_CODE),
          decision: "deny",
        },
        [`testproto_sso=${SSO_JWT}`]
      ),
      {} as any,
      {} as any
    );

    expect(res.statusCode).toBe(302);
    const loc = new URL(res.headers.location);
    expect(loc.searchParams.get("error")).toBe("access_denied");
    expect(loc.searchParams.get("code")).toBeNull();
    expect(ddbMock.commandCalls(DeleteCommand).length).toBeGreaterThan(0);
    expect(approvedPuts()).toHaveLength(0);
  });

  it("rejects an expired authorization", async () => {
    seed({ ...pendingAuthRequest(), expiresAt: Date.now() - 1000 });
    const res: any = await handler(
      consentEvent(
        {
          oauth_code: AUTH_CODE,
          csrf: expectedCsrf(AUTH_CODE),
          decision: "approve",
        },
        [`testproto_sso=${SSO_JWT}`]
      ),
      {} as any,
      {} as any
    );

    expect(res.statusCode).toBe(400);
    expect(approvedPuts()).toHaveLength(0);
  });
});
