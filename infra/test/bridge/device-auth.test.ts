import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { keysAfterRotate, pruneKeysAfterAuth, verifyDeviceAssertion } from "../../lib/lambdas/bridge/device-auth";
import type { DeviceKey, MachineMeta } from "../../lib/lambdas/bridge/store";

const NOW = Date.UTC(2026, 10, 15, 12, 0, 0);

async function makeKey(kid: string) {
  const { publicKey, privateKey } = await generateKeyPair("EdDSA", { crv: "Ed25519", extractable: true });
  const jwk = await exportJWK(publicKey);
  const key: DeviceKey = { kid, jwk: { kty: "OKP", crv: "Ed25519", x: jwk.x! }, addedAt: NOW };
  return { key, privateKey };
}

type PrivateKey = Awaited<ReturnType<typeof generateKeyPair>>["privateKey"];

async function assertion(privateKey: PrivateKey, o: { kid?: string; iss?: string; aud?: string; iat?: number; exp?: number; jti?: string } = {}) {
  const iat = o.iat ?? Math.floor(NOW / 1000);
  return new SignJWT({})
    .setProtectedHeader({ alg: "EdDSA", kid: o.kid ?? "k1" })
    .setIssuer(o.iss ?? "mini")
    .setSubject(o.iss ?? "mini")
    .setAudience(o.aud ?? "local-bridge-device")
    .setIssuedAt(iat)
    .setExpirationTime(o.exp ?? iat + 60)
    .setJti(o.jti ?? "0123456789abcdef0123")
    .sign(privateKey);
}

function deps(machine: MachineMeta | null) {
  const seen = new Set<string>();
  return {
    getMachine: async (id: string) => (machine && machine.id === id ? machine : null),
    claimJti: async (jti: string) => (seen.has(jti) ? false : (seen.add(jti), true)),
    now: () => NOW,
  };
}

describe("device assertion", () => {
  it("accepts an assertion signed by the registered key", async () => {
    const { key, privateKey } = await makeKey("k1");
    const d = deps({ id: "mini", enabled: true, keys: [key] });
    expect(await verifyDeviceAssertion(await assertion(privateKey), d)).toEqual({ ok: true, machine: "mini", kid: "k1" });
  });

  it("rejects a replayed assertion", async () => {
    const { key, privateKey } = await makeKey("k1");
    const d = deps({ id: "mini", enabled: true, keys: [key] });
    const token = await assertion(privateKey);
    expect((await verifyDeviceAssertion(token, d)).ok).toBe(true);
    expect(await verifyDeviceAssertion(token, d)).toEqual({ ok: false, reason: "replayed" });
  });

  it("rejects a signature from a different key, even with the registered kid", async () => {
    const { key } = await makeKey("k1");
    const other = await makeKey("k1");
    const r = await verifyDeviceAssertion(await assertion(other.privateKey), deps({ id: "mini", enabled: true, keys: [key] }));
    expect(r.ok).toBe(false);
  });

  it("rejects unknown machines, disabled machines, unknown and expired keys", async () => {
    const { key, privateKey } = await makeKey("k1");
    const token = await assertion(privateKey);
    expect(await verifyDeviceAssertion(token, deps(null))).toEqual({ ok: false, reason: "unknown_machine" });
    expect(await verifyDeviceAssertion(token, deps({ id: "mini", enabled: false, keys: [key] }))).toEqual({ ok: false, reason: "machine_disabled" });
    expect(await verifyDeviceAssertion(await assertion(privateKey, { kid: "k9" }), deps({ id: "mini", enabled: true, keys: [key] }))).toEqual({ ok: false, reason: "unknown_key" });
    expect(await verifyDeviceAssertion(token, deps({ id: "mini", enabled: true, keys: [{ ...key, expiresAt: NOW - 1 }] }))).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("rejects expired assertions, wrong audiences and over-long lifetimes", async () => {
    const { key, privateKey } = await makeKey("k1");
    const m: MachineMeta = { id: "mini", enabled: true, keys: [key] };
    const old = Math.floor(NOW / 1000) - 600;
    expect((await verifyDeviceAssertion(await assertion(privateKey, { iat: old }), deps(m))).ok).toBe(false);
    expect((await verifyDeviceAssertion(await assertion(privateKey, { aud: "local-bridge_app" }), deps(m))).ok).toBe(false);
    const iat = Math.floor(NOW / 1000);
    expect(await verifyDeviceAssertion(await assertion(privateKey, { exp: iat + 86_400 }), deps(m))).toEqual({ ok: false, reason: "lifetime_too_long" });
  });

  it("rejects a token that is not EdDSA (for example the HS256 agent JWT)", async () => {
    const { key } = await makeKey("k1");
    const hs = await new SignJWT({}).setProtectedHeader({ alg: "HS256", kid: "k1" }).setIssuer("mini").sign(new TextEncoder().encode("secret-secret-secret-secret-1234"));
    expect(await verifyDeviceAssertion(hs, deps({ id: "mini", enabled: true, keys: [key] }))).toEqual({ ok: false, reason: "bad_alg" });
  });
});

describe("key rotation", () => {
  const k = (kid: string, expiresAt?: number): DeviceKey => ({ kid, jwk: { kty: "OKP", crv: "Ed25519", x: "x".repeat(43) }, addedAt: 0, expiresAt });

  it("adds the new key and puts the old one on a 24 hour clock", () => {
    const keys = keysAfterRotate([k("old")], "old", { kid: "new", jwk: k("new").jwk }, NOW);
    expect(keys.map((x) => [x.kid, x.expiresAt])).toEqual([["old", NOW + 24 * 3600 * 1000], ["new", undefined]]);
  });

  it("drops the outgoing key once the machine connects with the new one", () => {
    expect(pruneKeysAfterAuth([k("old", NOW + 1000), k("new")], "new")?.map((x) => x.kid)).toEqual(["new"]);
  });

  it("keeps both while the machine is still using the outgoing key", () => {
    expect(pruneKeysAfterAuth([k("old", NOW + 1000), k("new")], "old")).toBeNull();
  });
});
