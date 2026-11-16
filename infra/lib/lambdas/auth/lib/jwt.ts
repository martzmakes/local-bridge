import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";
import { SignJWT, jwtVerify } from "jose";

const ssm = new SSMClient({});
const SECRET_NAME = process.env.JWT_SECRET_NAME!;
const ISSUER = process.env.DOMAIN!;
const AUDIENCE = `${process.env.PROJECT_SLUG!}_app`;
const TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

// Allowlist gate — re-checked on every verifyJwt() call, not just at mint
// time. JWTs carry a 30-day TTL, so without this a revoked/removed email
// would keep full access for up to 30 days after being deallowlisted.
// Override at deploy time via ALLOWED_EMAILS env var (comma-separated).
function getAllowedEmails(): string[] {
  return (process.env.ALLOWED_EMAILS || "")
    .split(",")
    .map((e) => e.trim().toLowerCase())
    .filter(Boolean);
}

let cachedKey: Uint8Array | null = null;

async function getKey(): Promise<Uint8Array> {
  if (cachedKey) return cachedKey;
  const res = await ssm.send(
    new GetParameterCommand({ Name: SECRET_NAME, WithDecryption: true })
  );
  const value = res.Parameter?.Value;
  if (!value) throw new Error("JWT secret not found in SSM");
  cachedKey = new TextEncoder().encode(value);
  return cachedKey;
}

export interface MintOptions {
  /** Bridge agent this token acts as. Tokens without it cannot use /mcp. */
  agent?: string;
  /** Token version; minted (machine) tokens are revoked by bumping the agent's version. */
  tv?: number;
  /** "oauth" for connector sign-ins, "minted" for infra/scripts/mint.ts. */
  kind?: "oauth" | "minted";
  ttlSeconds?: number;
}

export async function mintJwt(email: string, opts: MintOptions = {}): Promise<string> {
  const key = await getKey();
  const claims: Record<string, unknown> = {};
  if (opts.agent) claims.agent = opts.agent;
  if (opts.tv !== undefined) claims.tv = opts.tv;
  if (opts.kind) claims.kind = opts.kind;
  return await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(email)
    .setIssuedAt()
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setExpirationTime(Math.floor(Date.now() / 1000) + (opts.ttlSeconds ?? TTL_SECONDS))
    .sign(key);
}

export interface VerifiedJwt {
  email: string;
  agent?: string;
  tv?: number;
  kind?: "oauth" | "minted";
}

export async function verifyJwt(token: string): Promise<VerifiedJwt> {
  const key = await getKey();
  const { payload } = await jwtVerify(token, key, {
    issuer: ISSUER,
    audience: AUDIENCE,
  });
  if (typeof payload.sub !== "string" || !payload.sub) {
    throw new Error("JWT missing subject");
  }
  const email = payload.sub;
  const allowedEmails = getAllowedEmails();
  // Fail closed: an unset/empty ALLOWED_EMAILS must never mean "allow
  // everyone" — that would silently open the deployment to the world.
  if (allowedEmails.length === 0 || !allowedEmails.includes(email.toLowerCase())) {
    throw new Error("Email not in allowlist");
  }
  return {
    email,
    agent: typeof payload.agent === "string" ? payload.agent : undefined,
    tv: typeof payload.tv === "number" ? payload.tv : undefined,
    kind: payload.kind === "oauth" || payload.kind === "minted" ? payload.kind : undefined,
  };
}
