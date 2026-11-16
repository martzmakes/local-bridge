// The machine's Ed25519 device key (spec section 5.2). The private key lives in
// the login Keychain; the public JWK is what `admin.ts device register` stores.
import { createHash, randomUUID } from "node:crypto";
import { SignJWT, exportJWK, generateKeyPair, importJWK } from "jose";
import { DEVICE_ASSERTION_TTL_SECONDS, DEVICE_AUDIENCE } from "../../infra/lib/shared/protocol";
import { DEVICE_KEY_NEXT_SERVICE, DEVICE_KEY_SERVICE, type Keychain } from "./keychain";

export interface PublicDeviceJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  kid: string;
}
interface PrivateDeviceJwk {
  kty: "OKP";
  crv: "Ed25519";
  x: string;
  d: string;
}

/** First 16 hex characters of the SHA-256 of the public key's `x` value. */
export function kidFor(x: string): string {
  return createHash("sha256").update(x).digest("hex").slice(0, 16);
}

// Stored as base64url(JSON) so the Keychain value needs no quoting at all.
function encode(jwk: PrivateDeviceJwk): string {
  return Buffer.from(JSON.stringify(jwk), "utf8").toString("base64url");
}
function decode(stored: string): PrivateDeviceJwk {
  let jwk: Partial<PrivateDeviceJwk>;
  try {
    jwk = JSON.parse(Buffer.from(stored, "base64url").toString("utf8")) as Partial<PrivateDeviceJwk>;
  } catch {
    throw new Error("device key in the Keychain is not readable; run `init` again or re-register the device");
  }
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || typeof jwk.x !== "string" || typeof jwk.d !== "string") {
    throw new Error("device key in the Keychain has an unexpected format");
  }
  return { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d };
}
function toPublic(jwk: PrivateDeviceJwk): PublicDeviceJwk {
  return { kty: "OKP", crv: "Ed25519", x: jwk.x, kid: kidFor(jwk.x) };
}

async function newKey(): Promise<PrivateDeviceJwk> {
  const { privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const jwk = await exportJWK(privateKey);
  if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x || !jwk.d) throw new Error("unexpected key format from generateKeyPair");
  return { kty: "OKP", crv: "Ed25519", x: jwk.x, d: jwk.d };
}

export interface DeviceKeyOptions {
  now?: () => number;
}

export class DeviceKey {
  private readonly now: () => number;

  constructor(
    private readonly keychain: Keychain,
    private readonly machine: string,
    opts: DeviceKeyOptions = {},
  ) {
    this.now = opts.now ?? Date.now;
  }

  private async load(service: string): Promise<PrivateDeviceJwk | null> {
    const stored = await this.keychain.get(service, this.machine);
    return stored === null ? null : decode(stored);
  }

  /** The current public key, or null when `init` has not been run. */
  async publicJwk(): Promise<PublicDeviceJwk | null> {
    const jwk = await this.load(DEVICE_KEY_SERVICE);
    return jwk && toPublic(jwk);
  }

  /** The pending rotation key, or null. */
  async pendingPublicJwk(): Promise<PublicDeviceJwk | null> {
    const jwk = await this.load(DEVICE_KEY_NEXT_SERVICE);
    return jwk && toPublic(jwk);
  }

  /** Generates and stores a key if there is none. Never replaces an existing key. */
  async ensure(): Promise<{ jwk: PublicDeviceJwk; created: boolean }> {
    const existing = await this.publicJwk();
    if (existing) return { jwk: existing, created: false };
    const jwk = await newKey();
    await this.keychain.set(DEVICE_KEY_SERVICE, this.machine, encode(jwk));
    return { jwk: toPublic(jwk), created: true };
  }

  /** Generates the "next" key for rotation. Reuses one that is already pending. */
  async prepareRotation(): Promise<PublicDeviceJwk> {
    if (!(await this.publicJwk())) throw new Error("no device key yet; run `init` first");
    const pending = await this.pendingPublicJwk();
    if (pending) return pending;
    const jwk = await newKey();
    await this.keychain.set(DEVICE_KEY_NEXT_SERVICE, this.machine, encode(jwk));
    return toPublic(jwk);
  }

  /**
   * Makes the pending key current, once the cloud has confirmed it with
   * `{type:"rotated", kid}`. Returns false if `kid` is not the pending key.
   */
  async promote(kid: string): Promise<boolean> {
    const stored = await this.keychain.get(DEVICE_KEY_NEXT_SERVICE, this.machine);
    if (stored === null) return false;
    if (toPublic(decode(stored)).kid !== kid) return false;
    await this.keychain.set(DEVICE_KEY_SERVICE, this.machine, stored);
    await this.keychain.delete(DEVICE_KEY_NEXT_SERVICE, this.machine);
    return true;
  }

  /**
   * The pending key that still has to be announced to the cloud. Also finishes
   * a promotion that was interrupted between its two Keychain writes.
   */
  async pendingRotation(): Promise<PublicDeviceJwk | null> {
    const pending = await this.pendingPublicJwk();
    if (!pending) return null;
    const current = await this.publicJwk();
    if (current && current.kid === pending.kid) {
      await this.keychain.delete(DEVICE_KEY_NEXT_SERVICE, this.machine);
      return null;
    }
    return pending;
  }

  /** A fresh single-use assertion for the WebSocket upgrade. */
  async signAssertion(): Promise<string> {
    const jwk = await this.load(DEVICE_KEY_SERVICE);
    if (!jwk) throw new Error("no device key in the Keychain; run `local-bridge-agent init`");
    const key = await importJWK(jwk, "EdDSA");
    const iat = Math.floor(this.now() / 1000);
    return new SignJWT({})
      .setProtectedHeader({ alg: "EdDSA", kid: kidFor(jwk.x), typ: "JWT" })
      .setIssuer(this.machine)
      .setSubject(this.machine)
      .setAudience(DEVICE_AUDIENCE)
      .setIssuedAt(iat)
      .setExpirationTime(iat + DEVICE_ASSERTION_TTL_SECONDS)
      .setJti(randomUUID())
      .sign(key);
  }
}
