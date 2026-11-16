// Accounts. Every bridge row belongs to one account, and the account of a
// request always comes from a verified credential (the JWT's email, or the
// uid a machine's registered key lives under), never from a URL or a body.
// v2 spec section 9.
import { createHash } from "crypto";

export const UID_RE = /^[a-f0-9]{20}$/;

/** Account id for an email: derived, so there is no lookup to get wrong. */
export function uidFromEmail(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 20);
}

export function isUid(value: unknown): value is string {
  return typeof value === "string" && UID_RE.test(value);
}

export const MAX_MACHINES_PER_ACCOUNT = 10;
