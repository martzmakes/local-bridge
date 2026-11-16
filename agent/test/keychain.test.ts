import { describe, expect, it } from "vitest";
import { DEVICE_KEY_NEXT_SERVICE, DEVICE_KEY_SERVICE, Keychain } from "../src/keychain";
import { fakeSecurity } from "./helpers";

describe("keychain", () => {
  it("round-trips a secret without ever putting it in argv", async () => {
    const fake = fakeSecurity();
    const secret = "s3cr3t-value_ABC";
    await fake.keychain.set("com.example.svc", "mini", secret);
    expect(await fake.keychain.get("com.example.svc", "mini")).toBe(secret);
    expect(fake.calls.length).toBeGreaterThan(0);
    for (const call of fake.calls) {
      for (const arg of call.args) expect(arg).not.toContain(secret);
    }
    const write = fake.calls.find((c) => c.args[0] === "-i");
    expect(write?.args).toEqual(["-i"]);
    expect(write?.stdin).toContain(secret);
    const read = fake.calls.find((c) => c.args[0] === "find-generic-password");
    expect(read?.args).toEqual(["find-generic-password", "-s", "com.example.svc", "-a", "mini", "-w"]);
    expect(read?.stdin).toBeUndefined();
  });

  it("quotes quotes and backslashes for security -i", async () => {
    const fake = fakeSecurity();
    const secret = 'a "quoted" \\ value with spaces';
    await fake.keychain.set("svc", "acct", secret);
    expect(fake.calls[0]?.stdin).toBe('add-generic-password -U -s "svc" -a "acct" -w "a \\"quoted\\" \\\\ value with spaces"\n');
    expect(await fake.keychain.get("svc", "acct")).toBe(secret);
  });

  it("refuses a secret that could break out of the command line", async () => {
    const fake = fakeSecurity();
    await expect(fake.keychain.set("svc", "acct", "line1\ndelete-keychain")).rejects.toThrow(/control characters/);
    expect(fake.calls).toHaveLength(0);
    await expect(fake.keychain.set("svc; rm", "acct", "x")).rejects.toThrow(/invalid keychain service/);
  });

  it("returns null for a missing item and false when deleting one", async () => {
    const fake = fakeSecurity();
    expect(await fake.keychain.get("svc", "acct")).toBeNull();
    expect(await fake.keychain.delete("svc", "acct")).toBe(false);
    await fake.keychain.set("svc", "acct", "v");
    expect(await fake.keychain.delete("svc", "acct")).toBe(true);
    expect(await fake.keychain.get("svc", "acct")).toBeNull();
  });

  it("fails when the write cannot be read back", async () => {
    // `security -i` can exit 0 after a failed command.
    const keychain = new Keychain(async (args) => (args[0] === "-i" ? { code: 0, stdout: "", stderr: "" } : { code: 44, stdout: "", stderr: "" }));
    await expect(keychain.set("svc", "acct", "v")).rejects.toThrow(/could not be verified/);
  });

  it("surfaces other failures without the secret", async () => {
    const keychain = new Keychain(async () => ({ code: 51, stdout: "", stderr: "User interaction is not allowed." }));
    await expect(keychain.get("svc", "acct")).rejects.toThrow(/exit 51/);
  });

  it("uses the agreed service names", () => {
    expect(DEVICE_KEY_SERVICE).toBe("com.martzmakes.local-bridge.device-key");
    expect(DEVICE_KEY_NEXT_SERVICE).toBe("com.martzmakes.local-bridge.device-key.next");
  });
});
