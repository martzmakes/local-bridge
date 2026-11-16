// OAuth 2.1 + PKCE handler for MCP clients (Claude Desktop, etc).
//
// Implements the minimal OAuth server an MCP "remote connector" expects:
//   RFC 9728 — Protected Resource Metadata
//   RFC 8414 — Authorization Server Metadata
//   RFC 7591 — Dynamic Client Registration
//   RFC 7636 — PKCE
//
// Approval is gated by the magic-link sign-in (no bearer tokens copied by
// hand). When the user clicks the magic link, `auth/verify.ts` notices the
// `oauthCode` rider and approves this auth request, then redirects back to
// the client's callback.
//
// Endpoints (all served by this Lambda):
//   GET  /.well-known/oauth-protected-resource
//   GET  /.well-known/oauth-authorization-server
//   POST /oauth/register
//   GET  /oauth/authorize
//   POST /oauth/email
//   POST /oauth/token
//
// Delete this whole file (and the OAuth block in infra-stack.ts) if you
// don't expose an MCP server to remote clients.

import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  PutCommand,
  GetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { createHash, randomUUID } from "crypto";
import {
  issueRefreshToken,
  consumeRefreshToken,
  deleteRefreshToken,
} from "./refresh-tokens";
import { mintJwt, verifyJwt } from "../auth/lib/jwt";
import { sendMagicLinkEmail } from "../auth/lib/email";
import QRCode from "qrcode";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const OAUTH_TABLE = process.env.OAUTH_TABLE!;
const MAGIC_LINK_TOKENS_TABLE = process.env.MAGIC_LINK_TOKENS_TABLE!;
const PROJECT_SLUG = process.env.PROJECT_SLUG!;
const SITE_URL = process.env.SITE_URL!;
const WAITLIST_TABLE = process.env.WAITLIST_TABLE;

// Allowlist gate — mirrors auth/request.ts exactly.
const ALLOWED_EMAILS = (process.env.ALLOWED_EMAILS || "operator@example.com")
  .split(",")
  .map((e) => e.trim().toLowerCase())
  .filter(Boolean);

const SSO_COOKIE_NAME = `${PROJECT_SLUG}_sso`;
const AUTH_CODE_TTL_SECONDS = 15 * 60;
const CLIENT_TTL_SECONDS = 30 * 24 * 60 * 60; // 30 days
const MAGIC_LINK_TTL_SECONDS = 15 * 60;
// Refresh tokens are long-lived and ROTATED on every use (OAuth 2.1), so an
// actively-used connector keeps rolling forward well past this window; the TTL
// only bounds an idle connector. Without refresh tokens, the 30-day access
// token simply expired and Claude's MCP connector surfaced "Connection has
// expired. You can reconnect to re-authenticate" with no way to silently renew.
const ACCESS_TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // matches JWT TTL (30 days)

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface RegisteredClient {
  clientId: string;
  clientName: string;
  redirectUris: string[];
  createdAt: number;
}

interface AuthRequest {
  authCode: string;
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  codeChallengeMethod: string;
  state?: string;
  scope: string;
  approved: boolean;
  email?: string;
  expiresAt: number;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET,POST,OPTIONS",
  "access-control-allow-headers": "authorization,content-type",
  "access-control-expose-headers": "location",
};

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { "content-type": "application/json", ...CORS_HEADERS },
    body: JSON.stringify(body),
  };
}

function html(statusCode: number, body: string) {
  return {
    statusCode,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      ...CORS_HEADERS,
    },
    body,
  };
}

function errorJson(code: string, description: string, statusCode = 400) {
  return json(statusCode, { error: code, error_description: description });
}

function parseFormBody(body: string | null): Record<string, string> {
  if (!body) return {};
  const params = new URLSearchParams(body);
  const out: Record<string, string> = {};
  for (const [k, v] of params.entries()) out[k] = v;
  return out;
}

function readBody(event: { body?: string | null; isBase64Encoded?: boolean }): string {
  if (!event.body) return "";
  if (event.isBase64Encoded) {
    return Buffer.from(event.body, "base64").toString("utf-8");
  }
  return event.body;
}

// API Gateway HTTP API (payload v2) delivers cookies in the `event.cookies`
// array and STRIPS the Cookie header from `event.headers` — so reading
// headers.cookie always came up empty and the SSO fast-path never fired.
// Mirrors auth/session.ts::cookieValue.
function cookieValue(cookies: string[] | undefined, name: string): string | null {
  for (const c of cookies ?? []) {
    const eq = c.indexOf("=");
    if (eq <= 0) continue;
    if (c.slice(0, eq).trim() === name) {
      return decodeURIComponent(c.slice(eq + 1).trim());
    }
  }
  return null;
}

function base64url(buf: Buffer): string {
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

// Consent CSRF token: HMAC-ish binding of the pending auth code to the
// caller's session cookie. An attacker can neither read the victim's
// httpOnly cookie nor forge this value, so they cannot POST /oauth/consent
// on the victim's behalf. No extra storage needed — it is recomputed from
// the cookie presented on the POST.
function consentCsrfToken(ssoJwt: string, authCode: string): string {
  return base64url(
    createHash("sha256").update(`${ssoJwt}:${authCode}:consent`).digest()
  );
}

function escapeHtml(v: string): string {
  return v
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function validatePkce(verifier: string, challenge: string): boolean {
  const hash = createHash("sha256").update(verifier).digest();
  return base64url(hash) === challenge;
}

// CloudFront strips Host via ALL_VIEWER_EXCEPT_HOST_HEADER, so reading it
// would return execute-api.*. Use the env-pinned public URL.
function getBaseUrl(): string {
  return SITE_URL;
}

// ---------------------------------------------------------------------------
// DDB
// ---------------------------------------------------------------------------

async function putClient(c: RegisteredClient) {
  await ddb.send(
    new PutCommand({
      TableName: OAUTH_TABLE,
      Item: {
        pk: `CLIENT#${c.clientId}`,
        sk: "CLIENT",
        ...c,
        ttl: Math.floor(Date.now() / 1000) + CLIENT_TTL_SECONDS,
      },
    })
  );
}

async function getClient(clientId: string): Promise<RegisteredClient | null> {
  const res = await ddb.send(
    new GetCommand({
      TableName: OAUTH_TABLE,
      Key: { pk: `CLIENT#${clientId}`, sk: "CLIENT" },
    })
  );
  return (res.Item as RegisteredClient) || null;
}

async function putAuthRequest(a: AuthRequest) {
  await ddb.send(
    new PutCommand({
      TableName: OAUTH_TABLE,
      Item: {
        pk: `AUTH#${a.authCode}`,
        sk: "AUTH",
        ...a,
        ttl: Math.floor(a.expiresAt / 1000),
      },
    })
  );
}

async function getAuthRequest(authCode: string): Promise<AuthRequest | null> {
  const res = await ddb.send(
    new GetCommand({
      TableName: OAUTH_TABLE,
      Key: { pk: `AUTH#${authCode}`, sk: "AUTH" },
    })
  );
  return (res.Item as AuthRequest) || null;
}

async function deleteAuthRequest(authCode: string) {
  await ddb.send(
    new DeleteCommand({
      TableName: OAUTH_TABLE,
      Key: { pk: `AUTH#${authCode}`, sk: "AUTH" },
    })
  );
}

// Refresh tokens live in ./refresh-tokens.ts — opaque high-entropy strings,
// only sha256(token) persisted, rotated with a reuse-grace window so the
// connector's concurrent/retried refreshes don't strand it (the macrovault
// delete-on-use bug, 2026-05-18; nightswarm hit the same strand 2026-07-23).

// ---------------------------------------------------------------------------
// Discovery (well-known)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Resources (Local Bridge)
//
// Every MCP endpoint is its own protected resource: /mcp (all servers) and
// /mcp/<machine>/<server> (one local server). They share this authorization
// server and its tokens: a grant made for one endpoint works on all of them.
// Every connector sign-in is the built-in agent "owner"; which tools exist on
// an endpoint is decided on the Mac, in the app.
// ---------------------------------------------------------------------------

export const OWNER_AGENT = "owner";
const NAME = "[a-z0-9]{1,16}";
const RESOURCE_PATH_RE = new RegExp(`^/mcp(/${NAME}/${NAME})?$`);

/** The path of a resource URL if it is one of this server's MCP endpoints, else null. */
export function resourcePath(resource: string | undefined, baseUrl: string): string | null {
  if (!resource) return "/mcp";
  const r = resource.replace(/\/+$/, "");
  if (r === baseUrl) return "/mcp";
  if (!r.startsWith(`${baseUrl}/`)) return null;
  const path = r.slice(baseUrl.length);
  return RESOURCE_PATH_RE.test(path) ? path : null;
}

/** Client-requested scope with any agent: entries removed; a client never picks its agent. */
export function cleanScope(scope: string | undefined): string {
  const kept = (scope || "mcp:read mcp:tools").split(/\s+/).filter((x) => x && !x.startsWith("agent:"));
  return kept.length ? kept.join(" ") : "mcp:read mcp:tools";
}

function protectedResourceMetadata(baseUrl: string, path: string = "/mcp") {
  return {
    resource: `${baseUrl}${path}`,
    authorization_servers: [baseUrl],
    scopes_supported: ["mcp:read", "mcp:tools"],
    bearer_methods_supported: ["header"],
  };
}

function authorizationServerMetadata(baseUrl: string) {
  return {
    issuer: baseUrl,
    authorization_endpoint: `${baseUrl}/oauth/authorize`,
    token_endpoint: `${baseUrl}/oauth/token`,
    registration_endpoint: `${baseUrl}/oauth/register`,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    scopes_supported: ["mcp:read", "mcp:tools"],
    token_endpoint_auth_methods_supported: ["none"],
    service_documentation: `${baseUrl}/`,
  };
}

// ---------------------------------------------------------------------------
// Endpoint handlers
// ---------------------------------------------------------------------------

async function handleRegister(raw: string) {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw || "{}");
  } catch {
    return errorJson("invalid_request", "Invalid JSON body");
  }
  const redirectUris = Array.isArray(body.redirect_uris)
    ? (body.redirect_uris as string[])
    : [];
  if (redirectUris.length === 0) {
    return errorJson("invalid_redirect_uri", "At least one redirect_uri is required");
  }
  const clientId = randomUUID();
  const clientName =
    typeof body.client_name === "string" && body.client_name
      ? body.client_name
      : `Client ${clientId.slice(0, 8)}`;
  const client: RegisteredClient = {
    clientId,
    clientName,
    redirectUris,
    createdAt: Date.now(),
  };
  await putClient(client);
  return {
    statusCode: 201,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...CORS_HEADERS,
    },
    body: JSON.stringify({
      client_id: clientId,
      client_name: clientName,
      redirect_uris: redirectUris,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      client_id_issued_at: Math.floor(Date.now() / 1000),
    }),
  };
}

async function handleAuthorize(
  params: Record<string, string | undefined>,
  baseUrl: string,
  cookies: string[] | undefined
) {
  const {
    client_id,
    redirect_uri,
    response_type,
    code_challenge,
    code_challenge_method,
    state,
    scope,
    resource,
  } = params;

  if (resourcePath(resource, baseUrl) === null) {
    return errorJson("invalid_target", "resource is not an MCP URL of this server");
  }

  if (!client_id) return errorJson("invalid_request", "client_id is required");
  if (!redirect_uri) return errorJson("invalid_request", "redirect_uri is required");
  if (response_type !== "code")
    return errorJson("unsupported_response_type", "Only code is supported");
  if (!code_challenge)
    return errorJson("invalid_request", "code_challenge is required");
  if (code_challenge_method !== "S256")
    return errorJson("invalid_request", "Only S256 is supported");

  const client = await getClient(client_id);
  if (!client) {
    return errorJson("invalid_client", "Unknown client_id");
  }
  // RFC 6749 §10.6 / authorization-code-interception defense: redirect_uri
  // must exactly match one registered for this client at /oauth/register
  // time. Without this check an attacker who obtains a valid client_id
  // (registration is open/anonymous per RFC 7591) could pass their own
  // redirect_uri and have an approved auth code delivered to them instead
  // of the legitimate client.
  if (!client.redirectUris?.includes(redirect_uri)) {
    return errorJson(
      "invalid_request",
      "redirect_uri is not registered for this client"
    );
  }
  const clientName = client.clientName || "Application";

  const authCode = randomUUID();
  const authRequest: AuthRequest = {
    authCode,
    clientId: client_id,
    redirectUri: redirect_uri,
    codeChallenge: code_challenge,
    codeChallengeMethod: code_challenge_method,
    state,
    scope: cleanScope(scope),
    approved: false,
    expiresAt: Date.now() + AUTH_CODE_TTL_SECONDS * 1000,
    createdAt: Date.now(),
  };
  await putAuthRequest(authRequest);

  // SSO path: a valid session cookie skips the email loop, but it does NOT
  // skip consent. /oauth/register is open (RFC 7591), so anyone can register
  // a client pointing at their own redirect_uri; if a signed-in user merely
  // *visiting* an attacker-crafted /oauth/authorize link silently minted an
  // approved code, the attacker would receive a working MCP token without the
  // user ever agreeing to anything (classic authorization-request CSRF /
  // confused deputy — the consent screen is the control OAuth relies on here,
  // and PKCE does not help because the attacker generates their own verifier).
  // So: render an explicit Approve/Deny screen carrying a CSRF token bound to
  // this session cookie, and only grant on the POST.
  const ssoJwt = cookieValue(cookies, SSO_COOKIE_NAME);
  if (ssoJwt) {
    try {
      const { email } = await verifyJwt(ssoJwt);
      if (email) {
        return html(
          200,
          renderConsentPage({
            clientName,
            authCode,
            email,
            csrfToken: consentCsrfToken(ssoJwt, authCode),
            redirectUri: redirect_uri,
          })
        );
      }
    } catch {
      // Stale / invalid cookie — fall through to sign-in page.
    }
  }

  const handoffUrl = `${baseUrl}/oauth/authorize?oauthCode=${authCode}&handoff=1`;
  let qrDataUrl = "";
  try {
    qrDataUrl = await QRCode.toDataURL(handoffUrl, { width: 220, margin: 1 });
  } catch {
    qrDataUrl = "";
  }

  return html(200, renderSignInPage({ clientName, authCode, qrDataUrl }));
}

// POST /oauth/consent — the Approve/Deny submit from the SSO consent screen.
// Requires BOTH a valid session cookie and the cookie-bound CSRF token, so a
// cross-site POST cannot approve an authorization on the user's behalf.
async function handleConsent(raw: string, cookies: string[] | undefined) {
  const form = parseFormBody(raw);
  const oauthCode = (form.oauth_code || form.oauthCode || "").trim();
  const csrf = (form.csrf || "").trim();
  const decision = (form.decision || "").trim();
  if (!oauthCode) return errorJson("invalid_request", "oauth_code is required");

  const ssoJwt = cookieValue(cookies, SSO_COOKIE_NAME);
  if (!ssoJwt) return errorJson("invalid_grant", "no active session", 401);

  let email: string | undefined;
  try {
    ({ email } = await verifyJwt(ssoJwt));
  } catch {
    return errorJson("invalid_grant", "invalid session", 401);
  }
  if (!email) return errorJson("invalid_grant", "invalid session", 401);

  const authRequest = await getAuthRequest(oauthCode);
  if (!authRequest) return errorJson("invalid_grant", "unknown authorization");
  if (authRequest.expiresAt < Date.now()) {
    return errorJson("invalid_grant", "authorization expired");
  }

  if (csrf !== consentCsrfToken(ssoJwt, oauthCode)) {
    console.log("oauth_consent_csrf_reject", { clientId: authRequest.clientId });
    return errorJson("invalid_request", "invalid consent token", 403);
  }

  const callback = new URL(authRequest.redirectUri);
  if (decision !== "approve") {
    // RFC 6749 §4.1.2.1 — report the refusal to the client rather than
    // leaving it hanging on a code that will never arrive.
    await deleteAuthRequest(oauthCode);
    callback.searchParams.set("error", "access_denied");
    if (authRequest.state) callback.searchParams.set("state", authRequest.state);
    return {
      statusCode: 302,
      headers: { location: callback.toString(), ...CORS_HEADERS },
      body: "",
    };
  }

  await putAuthRequest({ ...authRequest, approved: true, email });
  callback.searchParams.set("code", oauthCode);
  if (authRequest.state) callback.searchParams.set("state", authRequest.state);
  return {
    statusCode: 302,
    headers: { location: callback.toString(), ...CORS_HEADERS },
    body: "",
  };
}

async function handleEmail(raw: string, baseUrl: string) {
  const form = parseFormBody(raw);
  const email = (form.email || "").trim().toLowerCase();
  const oauthCode = (form.oauth_code || form.oauthCode || "").trim();
  if (!email || !EMAIL_RE.test(email)) {
    return errorJson("invalid_request", "valid email is required");
  }
  if (!oauthCode) return errorJson("invalid_request", "oauth_code is required");

  const authRequest = await getAuthRequest(oauthCode);
  if (!authRequest) return errorJson("invalid_grant", "unknown authorization");
  if (authRequest.expiresAt < Date.now()) {
    return errorJson("invalid_grant", "authorization expired");
  }

  // Allowlist gate — same logic as auth/request.ts. Non-allowlisted emails
  // get a best-effort waitlist write and the same success page, so the
  // response is indistinguishable. No token minted, no SES call.
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
              referrer: null,
            },
            ConditionExpression: "attribute_not_exists(email)",
          })
        );
        console.log("waitlist_signup", { email, prototype: PROJECT_SLUG });
      } catch (err) {
        console.log("waitlist_put_noop_or_error", {
          email,
          err: err instanceof Error ? err.name : String(err),
        });
      }
    }
    return html(200, renderEmailSentPage(email));
  }

  // Mint a magic-link token that carries the oauthCode — when the verify
  // Lambda consumes it, it'll approve the OAuth request and redirect.
  const magicToken = randomUUID();
  const nowSeconds = Math.floor(Date.now() / 1000);
  await ddb.send(
    new PutCommand({
      TableName: MAGIC_LINK_TOKENS_TABLE,
      Item: {
        token: magicToken,
        email,
        oauthCode,
        createdAt: Date.now(),
        ttl: nowSeconds + MAGIC_LINK_TTL_SECONDS,
      },
    })
  );

  const verifyUrl = `${baseUrl}/auth/verify?token=${encodeURIComponent(magicToken)}`;
  try {
    await sendMagicLinkEmail(email, verifyUrl);
  } catch (err) {
    console.error("sendMagicLinkEmail failed", err);
  }

  return html(200, renderEmailSentPage(email));
}

function tokenResponse(accessToken: string, refreshToken: string, scope: string) {
  return {
    statusCode: 200,
    headers: {
      "content-type": "application/json",
      "cache-control": "no-store",
      ...CORS_HEADERS,
    },
    body: JSON.stringify({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      scope,
    }),
  };
}

async function handleToken(raw: string, contentType: string) {
  let body: Record<string, string>;
  if (contentType.includes("application/x-www-form-urlencoded")) {
    body = parseFormBody(raw);
  } else {
    try {
      body = JSON.parse(raw || "{}") as Record<string, string>;
    } catch {
      return errorJson("invalid_request", "Invalid request body");
    }
  }
  const { grant_type } = body;
  if (grant_type === "authorization_code") {
    return handleAuthorizationCodeGrant(body);
  }
  if (grant_type === "refresh_token") {
    return handleRefreshTokenGrant(body);
  }
  return errorJson(
    "unsupported_grant_type",
    `Unsupported grant_type: ${grant_type}`
  );
}

async function handleAuthorizationCodeGrant(body: Record<string, string>) {
  const { code, code_verifier } = body;
  if (!code) return errorJson("invalid_request", "code is required");
  if (!code_verifier) return errorJson("invalid_request", "code_verifier is required");

  const authRequest = await getAuthRequest(code);
  if (!authRequest)
    return errorJson("invalid_grant", "Invalid or expired authorization code");
  if (authRequest.expiresAt < Date.now()) {
    await deleteAuthRequest(code);
    return errorJson("invalid_grant", "Authorization code has expired");
  }
  if (!authRequest.approved || !authRequest.email) {
    return errorJson("authorization_pending", "Authorization is pending");
  }
  if (!validatePkce(code_verifier, authRequest.codeChallenge)) {
    return errorJson("invalid_grant", "PKCE verification failed");
  }

  await deleteAuthRequest(code); // single-use

  const accessToken = await mintJwt(authRequest.email, { agent: OWNER_AGENT, kind: "oauth" });
  const refreshToken = await issueRefreshToken(ddb, OAUTH_TABLE, {
    email: authRequest.email,
    clientId: authRequest.clientId,
    scope: authRequest.scope,
  });

  return tokenResponse(accessToken, refreshToken, authRequest.scope);
}

// refresh_token grant (OAuth 2.1, RFC 6749 §6) with rotation: the presented
// token is invalidated and a brand-new one is returned. This is what lets
// Claude's MCP connector silently renew instead of expiring.
async function handleRefreshTokenGrant(body: Record<string, string>) {
  const { refresh_token, client_id } = body;
  if (!refresh_token)
    return errorJson("invalid_request", "refresh_token is required");
  // Public clients bind the request to their client_id.
  if (!client_id) return errorJson("invalid_request", "client_id is required");

  // Rotation with a reuse-grace window: the connector fires concurrent /
  // retried refreshes; every request presenting the same (still-in-grace)
  // token gets the SAME successor instead of one winner + N stranded losers.
  const rec = await consumeRefreshToken(ddb, OAUTH_TABLE, refresh_token);
  if (!rec) {
    console.log("oauth_refresh_reject", { client_id });
    return errorJson("invalid_grant", "Invalid or expired refresh token");
  }
  if (rec.clientId !== client_id) {
    // A refresh token presented by a different client is treated as
    // compromised — revoke it (and its just-minted successor) rather than
    // honoring it.
    await deleteRefreshToken(ddb, OAUTH_TABLE, refresh_token);
    await deleteRefreshToken(ddb, OAUTH_TABLE, rec.rotatedRefreshToken);
    console.log("oauth_refresh_client_mismatch", { client_id });
    return errorJson(
      "invalid_grant",
      "refresh token was not issued to this client"
    );
  }
  const accessToken = await mintJwt(rec.email, { agent: OWNER_AGENT, kind: "oauth" });
  console.log("oauth_refresh_ok", { client_id });

  return tokenResponse(accessToken, rec.rotatedRefreshToken, rec.scope);
}

// ---------------------------------------------------------------------------
// HTML — uses the martzmakes design palette to match the rest of the app
// ---------------------------------------------------------------------------

const PAGE_STYLES = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body {
    font-family: 'General Sans', -apple-system, Segoe UI, Roboto, sans-serif;
    background: #07090C;
    color: #EEF1F6;
    min-height: 100vh;
    display: flex; align-items: center; justify-content: center;
    padding: 24px;
    letter-spacing: -0.01em;
  }
  .card {
    background: #11151C; border: 1px solid rgba(255,255,255,0.10);
    border-radius: 10px; padding: 32px;
    max-width: 440px; width: 100%;
  }
  .eyebrow {
    font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
    font-size: 11px; letter-spacing: 0.08em;
    color: #8892A0; text-transform: uppercase;
    margin-bottom: 12px;
  }
  h1 { font-size: 22px; font-weight: 600; letter-spacing: -0.02em; margin-bottom: 6px; }
  .sub { color: #B8C0CC; font-size: 14px; line-height: 20px; margin-bottom: 24px; }
  .client { color: #3B82FF; font-weight: 600; }
  .qr-row {
    display: flex; gap: 16px; align-items: center;
    background: #0B0E13; border: 1px solid rgba(255,255,255,0.10);
    border-radius: 8px; padding: 16px; margin-bottom: 24px;
  }
  .qr-row img { width: 96px; height: 96px; border-radius: 6px; background: #fff; padding: 4px; }
  .qr-copy { font-size: 12px; color: #8892A0; line-height: 18px; }
  label {
    display: block; color: #8892A0; font-size: 11px;
    margin-bottom: 6px; text-transform: uppercase; letter-spacing: 0.08em;
    font-family: 'JetBrains Mono', ui-monospace, Menlo, monospace;
  }
  input[type=email] {
    width: 100%; background: #171C25; color: #EEF1F6;
    border: 1px solid rgba(255,255,255,0.10); border-radius: 6px;
    padding: 12px; font-size: 15px; outline: none;
    font-family: 'General Sans', -apple-system, sans-serif;
  }
  input[type=email]:focus { border-color: #3B82FF; }
  button {
    width: 100%; margin-top: 16px;
    background: #3B82FF; color: #fff; border: 0;
    border-radius: 6px; padding: 12px; font-size: 14px; font-weight: 500;
    cursor: pointer;
    font-family: 'General Sans', -apple-system, sans-serif;
  }
  button:hover { background: #5897FF; }
  button.secondary {
    background: transparent; color: #9AA3B2;
    border: 1px solid rgba(255,255,255,0.10); margin-top: 8px;
  }
  button.secondary:hover { background: #171C25; color: #EEF1F6; }
  .hint { color: #5D6674; font-size: 12px; text-align: center; margin-top: 12px; }
  .email-pill { color: #3B82FF; font-weight: 600; }
`;

function renderConsentPage(args: {
  clientName: string;
  authCode: string;
  email: string;
  csrfToken: string;
  redirectUri: string;
}): string {
  const name = escapeHtml(args.clientName);
  const email = escapeHtml(args.email);
  let host = args.redirectUri;
  try {
    host = new URL(args.redirectUri).host;
  } catch {
    // keep the raw value if it will not parse
  }
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize ${name}</title>
<style>${PAGE_STYLES}</style>
</head><body>
<div class="card">
  <div class="eyebrow">CONNECT</div>
  <h1>Authorize access</h1>
  <p class="sub"><span class="client">${name}</span> wants to access your account via MCP.</p>
  <p class="hint">Signed in as <span class="email-pill">${email}</span>. Codes will be sent to <strong>${escapeHtml(
    host
  )}</strong>. Only approve this if you just started this connection yourself.</p>
  <form method="POST" action="/oauth/consent">
    <input type="hidden" name="oauth_code" value="${escapeHtml(args.authCode)}" />
    <input type="hidden" name="csrf" value="${escapeHtml(args.csrfToken)}" />
    <button type="submit" name="decision" value="approve">Approve</button>
    <button type="submit" name="decision" value="deny" class="secondary">Deny</button>
  </form>
</div>
</body></html>`;
}

function renderSignInPage(args: {
  clientName: string;
  authCode: string;
  qrDataUrl: string;
}): string {
  const escaped = args.clientName
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Authorize ${escaped}</title>
<style>${PAGE_STYLES}</style>
</head><body>
<div class="card">
  <div class="eyebrow">CONNECT</div>
  <h1>Authorize access</h1>
  <p class="sub"><span class="client">${escaped}</span> wants to access your account via MCP.</p>
  ${
    args.qrDataUrl
      ? `<div class="qr-row">
      <img src="${args.qrDataUrl}" alt="QR code" />
      <div class="qr-copy">On your phone? Scan to finish sign-in on mobile. This page updates automatically once you approve.</div>
    </div>`
      : ""
  }
  <form method="POST" action="/oauth/email">
    <input type="hidden" name="oauth_code" value="${args.authCode}" />
    <label for="email">Email</label>
    <input id="email" name="email" type="email" required autocomplete="email" placeholder="you@example.com" />
    <button type="submit">Send sign-in link</button>
  </form>
  <p class="hint">No passwords. We'll email a one-time link that completes the connection.</p>
</div>
</body></html>`;
}

function renderEmailSentPage(email: string): string {
  const escaped = email.replace(/</g, "&lt;");
  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>Check your email</title>
<style>${PAGE_STYLES} .card { text-align: center; }</style>
</head><body>
<div class="card">
  <div class="eyebrow">CHECK YOUR EMAIL</div>
  <h1>Sign-in link sent</h1>
  <p class="sub">Sent to <span class="email-pill">${escaped}</span>. Tap the link to finish connecting.</p>
  <p class="hint">Good for 15 minutes. You can close this window — the connector will pick up the session automatically.</p>
</div>
</body></html>`;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const method = event.requestContext.http.method;
  const path = event.rawPath || "";
  const headers = event.headers || {};
  const baseUrl = getBaseUrl();

  if (method === "OPTIONS") {
    return { statusCode: 204, headers: CORS_HEADERS, body: "" };
  }

  try {
    if (path === "/.well-known/oauth-protected-resource") {
      return json(200, protectedResourceMetadata(baseUrl));
    }
    // Path-specific metadata (RFC 9728 section 3.1): one document per endpoint.
    const PRM_PREFIX = "/.well-known/oauth-protected-resource/";
    if (path.startsWith(PRM_PREFIX)) {
      const resource = resourcePath(`${baseUrl}/${path.slice(PRM_PREFIX.length)}`, baseUrl);
      if (!resource) return errorJson("not_found", "Unknown resource", 404);
      return json(200, protectedResourceMetadata(baseUrl, resource));
    }
    if (path === "/.well-known/oauth-authorization-server") {
      return json(200, authorizationServerMetadata(baseUrl));
    }
    if (path === "/oauth/register" && method === "POST") {
      return await handleRegister(readBody(event));
    }
    if (path === "/oauth/authorize" && method === "GET") {
      return await handleAuthorize(
        event.queryStringParameters || {},
        baseUrl,
        event.cookies
      );
    }
    if (path === "/oauth/consent" && method === "POST") {
      return await handleConsent(readBody(event), event.cookies);
    }
    if (path === "/oauth/email" && method === "POST") {
      return await handleEmail(readBody(event), baseUrl);
    }
    if (path === "/oauth/token" && method === "POST") {
      const ct = headers["content-type"] || headers["Content-Type"] || "";
      return await handleToken(readBody(event), ct);
    }

    return errorJson("not_found", `Unknown endpoint: ${method} ${path}`, 404);
  } catch (err) {
    console.error("[oauth] handler error", err);
    return errorJson(
      "server_error",
      err instanceof Error ? err.message : String(err),
      500
    );
  }
};
