// infra/test/oauth/authorize-redirect-uri.test.ts
// RFC 6749 §10.6 — authorization-code interception. Dynamic Client
// Registration (RFC 7591) is open/anonymous here, so a client_id is not a
// secret: anyone who observes one can replay it. /oauth/authorize used to
// look the client up only for its display name and never checked that the
// supplied redirect_uri was one the client registered — so an attacker could
// send a live (SSO-cookied) victim to /oauth/authorize with a valid client_id
// and an attacker-controlled redirect_uri and have the auto-approve fast path
// 302 the auth code straight to them.
//
// The handler must reject an unknown client_id AND an unregistered
// redirect_uri BEFORE any AuthRequest row is written or any redirect happens.
import { mockClient } from "aws-sdk-client-mock";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import type { APIGatewayProxyEventV2 } from "aws-lambda";

process.env.OAUTH_TABLE = "test-oauth";
process.env.MAGIC_LINK_TOKENS_TABLE = "test-magic-links";
process.env.PROJECT_SLUG = "testproto";
process.env.SITE_URL = "https://testproto.example.com";
process.env.JWT_SECRET_NAME = "/test/jwt-secret";
process.env.DOMAIN = "testproto.example.com";
process.env.SES_FROM_ADDRESS = "noreply@testproto.example.com";
process.env.ALLOWED_EMAILS = "operator@example.com";

const ddbMock = mockClient(DynamoDBDocumentClient);

import { handler } from "../../lib/lambdas/oauth/handler";

const CLIENT_ID = "client-abc";
const REGISTERED_URI = "https://claude.ai/api/mcp/auth_callback";
const ATTACKER_URI = "https://evil.example.com/steal";

function authorizeEvent(
  params: Record<string, string>
): APIGatewayProxyEventV2 {
  return {
    version: "2.0",
    rawPath: "/oauth/authorize",
    rawQueryString: "",
    headers: {},
    queryStringParameters: params,
    requestContext: { http: { method: "GET" } },
    isBase64Encoded: false,
  } as unknown as APIGatewayProxyEventV2;
}

const baseParams = {
  client_id: CLIENT_ID,
  response_type: "code",
  code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
  code_challenge_method: "S256",
  state: "xyz",
};

/** Registers CLIENT_ID (or nothing, when `exists` is false) in the DDB fake. */
function seedClient(exists: boolean) {
  ddbMock.reset();
  ddbMock.on(GetCommand).callsFake((input) => {
    if (input.Key?.pk === `CLIENT#${CLIENT_ID}` && exists) {
      return {
        Item: {
          clientId: CLIENT_ID,
          clientName: "Claude",
          redirectUris: [REGISTERED_URI],
          createdAt: Date.now(),
        },
      };
    }
    return {};
  });
  ddbMock.on(PutCommand).resolves({});
}

/** Every AuthRequest row the handler attempted to persist. */
function authRequestWrites() {
  return ddbMock
    .commandCalls(PutCommand)
    .filter((c) => String(c.args[0].input.Item?.pk || "").startsWith("AUTH#"));
}

describe("/oauth/authorize redirect_uri validation", () => {
  it("accepts a redirect_uri registered for the client", async () => {
    seedClient(true);
    const res: any = await handler(
      authorizeEvent({ ...baseParams, redirect_uri: REGISTERED_URI }),
      {} as any,
      () => {}
    );
    // No SSO cookie -> sign-in page, and the AuthRequest is persisted.
    expect(res.statusCode).toBe(200);
    expect(res.body).toContain("Claude");
    expect(authRequestWrites()).toHaveLength(1);
  });

  it("rejects an unregistered redirect_uri with 400 and writes no AuthRequest", async () => {
    seedClient(true);
    const res: any = await handler(
      authorizeEvent({ ...baseParams, redirect_uri: ATTACKER_URI }),
      {} as any,
      () => {}
    );
    expect(res.statusCode).toBe(400);
    const body = JSON.parse(res.body);
    expect(body.error).toBe("invalid_request");
    expect(body.error_description).toMatch(/redirect_uri/i);
    // Nothing persisted and no redirect issued — the attacker's callback
    // never becomes a live, approvable auth request.
    expect(authRequestWrites()).toHaveLength(0);
    expect(res.headers?.location).toBeUndefined();
  });

  it("rejects an unknown client_id", async () => {
    seedClient(false);
    const res: any = await handler(
      authorizeEvent({ ...baseParams, redirect_uri: REGISTERED_URI }),
      {} as any,
      () => {}
    );
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toBe("invalid_client");
    expect(authRequestWrites()).toHaveLength(0);
  });
});
