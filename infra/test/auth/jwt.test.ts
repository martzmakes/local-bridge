// infra/test/auth/jwt.test.ts
// Covers the fleet-wide bug found across 5 bootstrapped prototypes
// (proto-recal, proto-gaveldm, proto-decideline, proto-trialguard,
// proto-loopback): verifyJwt() validated signature/issuer/audience/expiry
// but never re-checked ALLOWED_EMAILS on every call. Since JWTs carry a
// 30-day TTL, a revoked/removed email kept full access for up to 30 days
// after being deallowlisted. verifyJwt() must fail closed and re-check the
// CURRENT allowlist on every call, not just at mint time.
import { mockClient } from "aws-sdk-client-mock";
import { SSMClient, GetParameterCommand } from "@aws-sdk/client-ssm";

process.env.JWT_SECRET_NAME = "/test/jwt-secret";
process.env.DOMAIN = "test.example.com";
process.env.PROJECT_SLUG = "testproto";

const ssmMock = mockClient(SSMClient);
ssmMock.on(GetParameterCommand).resolves({
  Parameter: { Value: "unit-test-signing-secret-at-least-32-bytes-long!!" },
});

import { mintJwt, verifyJwt } from "../../lib/lambdas/auth/lib/jwt";

describe("verifyJwt allowlist re-check", () => {
  const OWNER = "operator@example.com";

  beforeEach(() => {
    process.env.ALLOWED_EMAILS = OWNER;
  });

  it("passes for an allowlisted email", async () => {
    const token = await mintJwt(OWNER);
    const { email } = await verifyJwt(token);
    expect(email).toBe(OWNER);
  });

  it("rejects a signature-valid token whose email was since deallowlisted", async () => {
    const token = await mintJwt(OWNER);
    // Simulate the owner being removed from the allowlist after the token
    // was minted (e.g. subscription cancelled, access revoked) — the token
    // itself is still cryptographically valid for up to 30 days.
    process.env.ALLOWED_EMAILS = "someone-else@example.com";
    await expect(verifyJwt(token)).rejects.toThrow(/allowlist/i);
  });

  it("rejects a token with a tampered signature", async () => {
    const token = await mintJwt(OWNER);
    const tampered = token.slice(0, -4) + "abcd";
    await expect(verifyJwt(tampered)).rejects.toThrow();
  });

  it("fails closed when ALLOWED_EMAILS is unset", async () => {
    const token = await mintJwt(OWNER);
    delete process.env.ALLOWED_EMAILS;
    await expect(verifyJwt(token)).rejects.toThrow(/allowlist/i);
  });

  it("fails closed when ALLOWED_EMAILS is set but empty", async () => {
    const token = await mintJwt(OWNER);
    process.env.ALLOWED_EMAILS = "  ,  ,";
    await expect(verifyJwt(token)).rejects.toThrow(/allowlist/i);
  });

  it("matches case-insensitively against the allowlist", async () => {
    const token = await mintJwt(OWNER.toUpperCase());
    process.env.ALLOWED_EMAILS = OWNER;
    const { email } = await verifyJwt(token);
    expect(email.toLowerCase()).toBe(OWNER);
  });
});
