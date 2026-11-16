// Account API for the macOS app: who am I, which Macs are on my account,
// register this Mac's device key, remove a Mac. v2 spec section 9.4.
//
// The account is always the one the bearer token belongs to. Nothing in a
// path or a body can name another account.
import { APIGatewayProxyHandlerV2 } from "aws-lambda";
import { createHash } from "crypto";
import { z } from "zod";
import { NAME_RE, OFFLINE_AFTER_MS } from "../../shared/protocol";
import { verifyJwt } from "../auth/lib/jwt";
import { errName, getStore, logEvent } from "../bridge/runtime";
import type { DeviceKey, Store } from "../bridge/store";
import { MAX_MACHINES_PER_ACCOUNT, uidFromEmail } from "../bridge/tenant";

const RegisterBody = z.strictObject({
  jwk: z
    .object({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: z.string().regex(/^[A-Za-z0-9_-]{43}$/), d: z.undefined().optional() })
    .loose(),
});

interface Response {
  statusCode: number;
  headers: Record<string, string>;
  body: string;
}

function json(statusCode: number, body: unknown): Response {
  return { statusCode, headers: { "content-type": "application/json", "cache-control": "no-store" }, body: JSON.stringify(body) };
}
const fail = (statusCode: number, error: string, message: string) => json(statusCode, { error, message });

export interface AccountRequest {
  method: string;
  path: string;
  body: string;
  email: string;
}

/** Key id: first 16 hex of sha256 over the JWK's x text. The daemon computes the same. */
export function kidFor(x: string): string {
  return createHash("sha256").update(x).digest("hex").slice(0, 16);
}

export async function handleAccount(req: AccountRequest, root: Store, now: () => number = Date.now): Promise<Response> {
  const uid = uidFromEmail(req.email);
  const store = root.forTenant(uid);
  const path = req.path.replace(/\/+$/, "");

  if (path === "/api/me" && req.method === "GET") return json(200, { email: req.email, uid });

  if (path === "/api/machines" && req.method === "GET") {
    const t = now();
    const machines = (await store.listMachines()).map((m) => ({
      machine: m.meta.id,
      enabled: m.meta.enabled,
      connected: m.meta.connectionId !== undefined && m.meta.lastSeenAt !== undefined && t - m.meta.lastSeenAt <= OFFLINE_AFTER_MS,
      lastSeen: m.meta.lastSeenAt ? new Date(m.meta.lastSeenAt).toISOString() : null,
      agentVersion: m.meta.agentVersion ?? null,
      kids: m.meta.keys.map((k) => k.kid),
      servers: m.servers.map((s) => ({ name: s.name, title: s.title ?? null, status: s.status, tools: s.tools.length })),
    }));
    return json(200, { machines });
  }

  const m = /^\/api\/machines\/([^/]+)$/.exec(path);
  if (m) {
    const machine = m[1];
    if (!NAME_RE.test(machine)) return fail(400, "invalid_machine", "machine names are 1-16 lowercase letters and digits");

    if (req.method === "PUT") {
      let parsed;
      try {
        parsed = RegisterBody.safeParse(JSON.parse(req.body || "null"));
      } catch {
        return fail(400, "invalid_body", "body must be JSON");
      }
      if (!parsed.success) return fail(400, "invalid_body", "expected { jwk: an Ed25519 PUBLIC key {kty, crv, x} }");
      const existing = await store.getMachine(machine);
      if (!existing) {
        const count = (await store.listMachines()).length;
        if (count >= MAX_MACHINES_PER_ACCOUNT) {
          return fail(409, "machine_limit", `an account can have at most ${MAX_MACHINES_PER_ACCOUNT} machines; remove one first`);
        }
      }
      const kid = kidFor(parsed.data.jwk.x);
      const key: DeviceKey = { kid, jwk: { kty: "OKP", crv: "Ed25519", x: parsed.data.jwk.x }, addedAt: now() };
      // Signing in on a Mac proves the account, so its key replaces whatever
      // was registered under that name before.
      await store.putMachineRegistration(machine, existing?.enabled ?? true, [key]);
      logEvent("machine_registered", { uid, machine, kid, replaced: existing !== null });
      return json(200, { uid, machine, kid });
    }

    if (req.method === "DELETE") {
      const removed = await store.deleteMachine(machine);
      if (!removed) return fail(404, "not_found", "no such machine on this account");
      logEvent("machine_removed", { uid, machine });
      return json(200, { removed: machine });
    }
  }

  return fail(404, "not_found", "unknown endpoint");
}

export const handler: APIGatewayProxyHandlerV2 = async (event) => {
  const method = event.requestContext.http.method;
  const match = /^Bearer\s+(.+)$/i.exec(event.headers?.authorization || event.headers?.Authorization || "");
  let email: string | null = null;
  if (match) {
    try {
      const claims = await verifyJwt(match[1]);
      // Only a sign-in token manages the account. Scoped agent tokens and the
      // web session cookie JWT cannot register or remove machines.
      if (claims.kind === "oauth" && claims.agent === "owner") email = claims.email;
    } catch {
      email = null;
    }
  }
  if (!email) return fail(401, "unauthorized", "sign in again");
  try {
    const body = event.isBase64Encoded ? Buffer.from(event.body ?? "", "base64").toString("utf8") : (event.body ?? "");
    if (body.length > 4096) return fail(400, "invalid_body", "body too large");
    return await handleAccount({ method, path: event.rawPath || "", body, email }, getStore());
  } catch (err) {
    logEvent("account_error", { error: errName(err) });
    return fail(500, "server_error", "internal error");
  }
};
