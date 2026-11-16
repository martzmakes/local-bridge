// Verifies the assertion a machine presents when it opens its WebSocket.
// Spec section 5.2. The machine holds an Ed25519 private key in its Keychain;
// the cloud only ever holds the public half.
import { decodeJwt, decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { DEVICE_ASSERTION_TTL_SECONDS, DEVICE_AUDIENCE, NAME_RE } from "../../shared/protocol";
import type { DeviceKey, MachineMeta } from "./store";
import { isUid } from "./tenant";

export interface DeviceAuthDeps {
  /** The machine `id` registered in account `uid`, if any. */
  getMachine(uid: string, id: string): Promise<MachineMeta | null>;
  claimJti(jti: string): Promise<boolean>;
  now?: () => number;
}

export type DeviceAuthResult =
  | { ok: true; uid: string; machine: string; kid: string }
  | { ok: false; reason: string };

export function activeKeys(keys: DeviceKey[], now: number): DeviceKey[] {
  return keys.filter((k) => k.expiresAt === undefined || k.expiresAt > now);
}

export async function verifyDeviceAssertion(token: string, deps: DeviceAuthDeps): Promise<DeviceAuthResult> {
  const now = (deps.now ?? Date.now)();
  let machineId: string;
  let uid: string;
  let kid: string | undefined;
  try {
    const header = decodeProtectedHeader(token);
    if (header.alg !== "EdDSA") return { ok: false, reason: "bad_alg" };
    kid = header.kid;
    const claims = decodeJwt(token);
    if (typeof claims.iss !== "string" || !NAME_RE.test(claims.iss)) return { ok: false, reason: "bad_issuer" };
    machineId = claims.iss;
    // The account is only a hint for which key to check: the signature below
    // has to verify against a key registered under exactly this account.
    if (!isUid(claims.uid)) return { ok: false, reason: "no_account" };
    uid = claims.uid;
  } catch {
    return { ok: false, reason: "malformed" };
  }
  if (!kid) return { ok: false, reason: "no_kid" };

  const machine = await deps.getMachine(uid, machineId);
  if (!machine) return { ok: false, reason: "unknown_machine" };
  if (!machine.enabled) return { ok: false, reason: "machine_disabled" };
  const key = activeKeys(machine.keys, now).find((k) => k.kid === kid);
  if (!key) return { ok: false, reason: "unknown_key" };

  try {
    const publicKey = await importJWK(key.jwk, "EdDSA");
    const { payload } = await jwtVerify(token, publicKey, {
      algorithms: ["EdDSA"],
      issuer: machineId,
      subject: machineId,
      audience: DEVICE_AUDIENCE,
      currentDate: new Date(now),
      clockTolerance: 30,
      requiredClaims: ["exp", "iat", "jti"],
    });
    // The assertion is meant to be minted per connection attempt. Refuse one
    // whose lifetime is longer than the protocol allows, however it was signed.
    const lifetime = (payload.exp as number) - (payload.iat as number);
    if (lifetime > DEVICE_ASSERTION_TTL_SECONDS + 5) return { ok: false, reason: "lifetime_too_long" };
    if (typeof payload.jti !== "string" || payload.jti.length < 16 || payload.jti.length > 64) {
      return { ok: false, reason: "bad_jti" };
    }
    if (!(await deps.claimJti(`${uid}:${machineId}:${payload.jti}`))) return { ok: false, reason: "replayed" };
  } catch {
    return { ok: false, reason: "bad_signature_or_claims" };
  }
  return { ok: true, uid, machine: machineId, kid };
}

/**
 * Key set after a successful connect with `kid`. Once the machine has proved
 * it holds a key newer than an expiring one, the expiring one is dropped.
 */
export function pruneKeysAfterAuth(keys: DeviceKey[], kid: string): DeviceKey[] | null {
  const used = keys.find((k) => k.kid === kid);
  if (!used || used.expiresAt !== undefined) return null;
  const pruned = keys.filter((k) => k.kid === kid || k.expiresAt === undefined);
  return pruned.length === keys.length ? null : pruned;
}

export const ROTATION_OVERLAP_MS = 24 * 3600 * 1000;

/** Key set after a rotate message from a connection authenticated with `currentKid`. */
export function keysAfterRotate(keys: DeviceKey[], currentKid: string, next: Pick<DeviceKey, "kid" | "jwk">, now: number): DeviceKey[] {
  if (keys.some((k) => k.kid === next.kid)) return keys;
  const kept = activeKeys(keys, now).map((k) =>
    k.kid === currentKid || k.expiresAt === undefined ? { ...k, expiresAt: now + ROTATION_OVERLAP_MS } : k
  );
  return [...kept, { kid: next.kid, jwk: next.jwk, addedAt: now }];
}
