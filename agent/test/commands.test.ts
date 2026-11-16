import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runCli } from "../src/commands";
import { DEVICE_KEY_NEXT_SERVICE, DEVICE_KEY_SERVICE } from "../src/keychain";
import { FIXTURE, fakeSecurity } from "./helpers";

describe("cli", () => {
  let dir: string;
  let configPath: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "lb-cli-"));
    configPath = join(dir, "config.json");
    const config = {
      machine: "mini",
      endpoint: "wss://bridge-ws.martzmakes.com",
      servers: {
        // The extra argument only makes the command line look like the Notes server.
        notes: { transport: "stdio", command: process.execPath, args: [FIXTURE, "apple-notes-mcp"], read: ["echo", "big"], write: ["write_thing"] },
        gone: { transport: "stdio", command: "/nonexistent/server", read: ["x"], write: [] },
      },
    };
    await writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  const run = async (argv: string[], fake = fakeSecurity()) => {
    const lines: string[] = [];
    const code = await runCli([...argv, "--config", configPath], { out: (l) => lines.push(l), keychain: fake.keychain });
    return { code, text: lines.join("\n"), fake };
  };

  it("init stores a key once and prints the JWK and the register command", async () => {
    const first = await run(["init"]);
    expect(first.code).toBe(0);
    expect(first.fake.store.has(first.fake.key(DEVICE_KEY_SERVICE, "mini"))).toBe(true);
    const jwkLine = first.text.split("\n").find((l) => l.startsWith('{"kty"'))!;
    const jwk = JSON.parse(jwkLine) as Record<string, string>;
    expect(Object.keys(jwk)).toEqual(["kty", "crv", "x", "kid"]);
    expect(first.text).toContain(`admin.ts device register mini '${jwkLine}'`);
    expect(first.text).not.toContain('"d"');

    const again = await run(["init"], first.fake);
    expect(again.text).toContain("already exists");
    expect(again.text).toContain(jwkLine);
    const pub = await run(["pubkey"], first.fake);
    expect(pub.text).toBe(jwkLine);
  });

  it("init works before a config exists when given --machine", async () => {
    const lines: string[] = [];
    const fake = fakeSecurity();
    const code = await runCli(["init", "--machine", "air", "--config", join(dir, "missing.json")], { out: (l) => lines.push(l), keychain: fake.keychain });
    expect(code).toBe(0);
    expect(fake.store.has(fake.key(DEVICE_KEY_SERVICE, "air"))).toBe(true);
    expect(lines.join("\n")).toContain("device register air ");
    await expect(runCli(["init", "--config", join(dir, "missing.json")], { out: () => {}, keychain: fake.keychain })).rejects.toThrow(/--machine/);
  });

  it("pubkey fails without a key", async () => {
    const r = await run(["pubkey"]);
    expect(r.code).toBe(1);
  });

  it("rotate-key stores a pending key and leaves the current one alone", async () => {
    const init = await run(["init"]);
    const before = init.fake.store.get(init.fake.key(DEVICE_KEY_SERVICE, "mini"));
    const r = await run(["rotate-key"], init.fake);
    expect(r.code).toBe(0);
    expect(init.fake.store.get(init.fake.key(DEVICE_KEY_SERVICE, "mini"))).toBe(before);
    expect(init.fake.store.has(init.fake.key(DEVICE_KEY_NEXT_SERVICE, "mini"))).toBe(true);
    expect(r.text).toMatch(/launchctl kill SIGHUP gui\/\$\(id -u\)\/com\.martzmakes\.local-bridge/);
    await expect(run(["rotate-key"])).rejects.toThrow(/init/);
  });

  it("doctor reports the key, each server, exposed and unexposed tools, and the permissions table", async () => {
    const init = await run(["init"]);
    const r = await run(["doctor"], init.fake);
    expect(r.code).toBe(1); // the "gone" server cannot start
    expect(r.text).toMatch(/ok\s+.*machine "mini"/);
    expect(r.text).toMatch(/ok\s+present in the Keychain, kid [0-9a-f]{16}/);
    expect(r.text).toMatch(/ok\s+notes: up, 3 tool\(s\) exposed/);
    expect(r.text).toMatch(/read\s+echo/);
    expect(r.text).toMatch(/write\s+write_thing/);
    expect(r.text).toMatch(/NOT exposed by the config \(7\)/);
    expect(r.text).toMatch(/-\s+hidden/);
    expect(r.text).toMatch(/FAIL\s+gone: down \(failed to start/);
    expect(r.text).toMatch(/notes\s+apple-notes-mcp\s+Automation: node to control Notes/);
    expect(r.text).toMatch(/gone\s+unknown server/);
    expect(r.text).toMatch(/\(agent\)\s+the agent itself\s+Keychain item access/);
    expect(r.text).toContain("problem(s) found");
  }, 30_000);

  it("doctor flags a missing key and a world-readable config", async () => {
    const r = await run(["doctor"]);
    expect(r.text).toMatch(/FAIL\s+no device key/);
    const open = join(dir, "open.json");
    await writeFile(open, "{}", { mode: 0o644 });
    const lines: string[] = [];
    expect(await runCli(["doctor", "--config", open], { out: (l) => lines.push(l), keychain: fakeSecurity().keychain })).toBe(1);
    expect(lines.join("\n")).toMatch(/FAIL.*readable by group or others/);
  }, 30_000);

  it("prints usage for help and rejects unknown commands", async () => {
    const lines: string[] = [];
    expect(await runCli(["--help"], { out: (l) => lines.push(l) })).toBe(0);
    expect(lines.join("\n")).toContain("rotate-key");
    await expect(runCli(["frobnicate"], { out: () => {} })).rejects.toThrow(/unknown command/);
  });
});
