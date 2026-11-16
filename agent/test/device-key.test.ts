import { createHash } from "node:crypto";
import { decodeProtectedHeader, importJWK, jwtVerify } from "jose";
import { describe, expect, it } from "vitest";
import { DEVICE_ASSERTION_TTL_SECONDS, DEVICE_AUDIENCE, RotateSchema } from "../../infra/lib/shared/protocol";
import { DeviceKey } from "../src/device-key";
import { DEVICE_KEY_NEXT_SERVICE, DEVICE_KEY_SERVICE } from "../src/keychain";
import { fakeSecurity } from "./helpers";

describe("device key", () => {
  it("generates once, stores under the device-key service, and exports a public JWK with a kid", async () => {
    const fake = fakeSecurity();
    const key = new DeviceKey(fake.keychain, "mini");
    expect(await key.publicJwk()).toBeNull();
    const first = await key.ensure();
    expect(first.created).toBe(true);
    expect(Object.keys(first.jwk).sort()).toEqual(["crv", "kid", "kty", "x"]);
    expect(first.jwk).toMatchObject({ kty: "OKP", crv: "Ed25519" });
    expect(first.jwk.kid).toBe(createHash("sha256").update(first.jwk.x).digest("hex").slice(0, 16));
    expect(fake.store.has(fake.key(DEVICE_KEY_SERVICE, "mini"))).toBe(true);
    // The public key satisfies the protocol's rotate message.
    expect(RotateSchema.safeParse({ type: "rotate", kid: first.jwk.kid, jwk: first.jwk }).success).toBe(true);

    const second = await key.ensure();
    expect(second).toEqual({ jwk: first.jwk, created: false });
  });

  it("never passes private key material in argv", async () => {
    const fake = fakeSecurity();
    await new DeviceKey(fake.keychain, "mini").ensure();
    const stored = fake.store.get(fake.key(DEVICE_KEY_SERVICE, "mini"))!;
    const d = (JSON.parse(Buffer.from(stored, "base64url").toString()) as { d: string }).d;
    for (const call of fake.calls) for (const arg of call.args) {
      expect(arg).not.toContain(stored);
      expect(arg).not.toContain(d);
    }
  });

  it("puts the account in the assertion as uid, and leaves the claim out when there is none", async () => {
    const fake = fakeSecurity();
    const { jwk } = await new DeviceKey(fake.keychain, "mini").ensure();
    const publicKey = await importJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }, "EdDSA");

    const withAccount = await new DeviceKey(fake.keychain, "mini", { account: "0123456789abcdef0123" }).signAssertion();
    expect(decodeProtectedHeader(withAccount)).toEqual({ alg: "EdDSA", kid: jwk.kid, typ: "JWT" });
    const { payload } = await jwtVerify(withAccount, publicKey, { audience: DEVICE_AUDIENCE, issuer: "mini", subject: "mini" });
    expect(payload.uid).toBe("0123456789abcdef0123");
    expect(Object.keys(payload).sort()).toEqual(["aud", "exp", "iat", "iss", "jti", "sub", "uid"]);

    const without = await new DeviceKey(fake.keychain, "mini").signAssertion();
    expect((await jwtVerify(without, publicKey)).payload).not.toHaveProperty("uid");
  });

  it("signs an assertion that verifies with the public JWK and carries the agreed claims", async () => {
    const fake = fakeSecurity();
    const now = 1_800_000_000_000;
    const key = new DeviceKey(fake.keychain, "mini", { now: () => now });
    const { jwk } = await key.ensure();
    const token = await key.signAssertion();

    expect(decodeProtectedHeader(token)).toMatchObject({ alg: "EdDSA", kid: jwk.kid });
    const publicKey = await importJWK({ kty: jwk.kty, crv: jwk.crv, x: jwk.x }, "EdDSA");
    const { payload } = await jwtVerify(token, publicKey, {
      audience: DEVICE_AUDIENCE,
      issuer: "mini",
      subject: "mini",
      algorithms: ["EdDSA"],
      currentDate: new Date(now),
    });
    expect(payload.iat).toBe(now / 1000);
    expect(payload.exp).toBe(now / 1000 + DEVICE_ASSERTION_TTL_SECONDS);
    expect(payload.jti).toMatch(/^[0-9a-f-]{36}$/);

    const again = await key.signAssertion();
    const second = await jwtVerify(again, publicKey, { currentDate: new Date(now) });
    expect(second.payload.jti).not.toBe(payload.jti);

    // Expired one TTL later.
    await expect(jwtVerify(token, publicKey, { currentDate: new Date(now + (DEVICE_ASSERTION_TTL_SECONDS + 1) * 1000) })).rejects.toThrow();
    // A different key does not verify it.
    const other = await new DeviceKey(fakeSecurity().keychain, "mini").ensure();
    const otherKey = await importJWK({ kty: "OKP", crv: "Ed25519", x: other.jwk.x }, "EdDSA");
    await expect(jwtVerify(token, otherKey, { currentDate: new Date(now) })).rejects.toThrow();
  });

  it("refuses to sign without a key", async () => {
    await expect(new DeviceKey(fakeSecurity().keychain, "mini").signAssertion()).rejects.toThrow(/init/);
  });

  it("keeps a pending key until the cloud confirms it, then promotes it", async () => {
    const fake = fakeSecurity();
    const key = new DeviceKey(fake.keychain, "mini");
    await expect(key.prepareRotation()).rejects.toThrow(/init/);
    const { jwk: current } = await key.ensure();
    expect(await key.pendingRotation()).toBeNull();

    const next = await key.prepareRotation();
    expect(next.kid).not.toBe(current.kid);
    expect(fake.store.has(fake.key(DEVICE_KEY_NEXT_SERVICE, "mini"))).toBe(true);
    expect(await key.prepareRotation()).toEqual(next); // idempotent while pending
    expect(await key.pendingRotation()).toEqual(next);
    // Still signing with the current key.
    expect(decodeProtectedHeader(await key.signAssertion()).kid).toBe(current.kid);

    expect(await key.promote("someotherkid")).toBe(false);
    expect((await key.publicJwk())?.kid).toBe(current.kid);

    expect(await key.promote(next.kid)).toBe(true);
    expect(await key.publicJwk()).toEqual(next);
    expect(fake.store.has(fake.key(DEVICE_KEY_NEXT_SERVICE, "mini"))).toBe(false);
    expect(decodeProtectedHeader(await key.signAssertion()).kid).toBe(next.kid);
    expect(await key.promote(next.kid)).toBe(false);
  });

  it("finishes a promotion that was interrupted between its two writes", async () => {
    const fake = fakeSecurity();
    const key = new DeviceKey(fake.keychain, "mini");
    await key.ensure();
    await key.prepareRotation();
    const nextStored = fake.store.get(fake.key(DEVICE_KEY_NEXT_SERVICE, "mini"))!;
    fake.store.set(fake.key(DEVICE_KEY_SERVICE, "mini"), nextStored); // current written, next not yet deleted
    expect(await key.pendingRotation()).toBeNull();
    expect(fake.store.has(fake.key(DEVICE_KEY_NEXT_SERVICE, "mini"))).toBe(false);
  });
});
