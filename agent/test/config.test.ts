import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ConfigError, accessFor, defaultConfigPath, loadConfig, parseConfig, resolveSecrets } from "../src/config";
import { fakeSecurity } from "./helpers";

const valid = {
  machine: "mini",
  endpoint: "wss://bridge-ws.martzmakes.com",
  servers: {
    notes: { transport: "stdio", command: "/usr/local/bin/node", args: ["/x/index.js"], read: ["get_note"], write: [] },
    ha: {
      transport: "sse",
      url: "http://127.0.0.1:8123/mcp_server/sse",
      headers: { Authorization: "keychain:local-bridge.ha-token" },
      read: ["GetLiveContext"],
    },
  },
};
const clone = () => structuredClone(valid) as Record<string, any>;

describe("config schema", () => {
  it("accepts the spec's shape and fills defaults", () => {
    const c = parseConfig(valid);
    expect(c.servers.notes).toMatchObject({ transport: "stdio", concurrency: 1, write: [] });
    expect(c.servers.ha).toMatchObject({ transport: "sse", concurrency: 1, write: [] });
  });

  it("rejects bad machine and server names", () => {
    const a = clone();
    a.machine = "Mini";
    expect(() => parseConfig(a)).toThrow(ConfigError);
    const b = clone();
    b.servers["my_notes"] = b.servers.notes;
    expect(() => parseConfig(b)).toThrow(/server names/);
    const c = clone();
    c.servers["averyveryverylongname"] = c.servers.notes;
    expect(() => parseConfig(c)).toThrow(ConfigError);
  });

  it("rejects unknown keys, so a typo cannot silently drop an allowlist", () => {
    const a = clone();
    a.servers.notes.reads = ["x"];
    expect(() => parseConfig(a)).toThrow(ConfigError);
    const b = clone();
    b.extra = true;
    expect(() => parseConfig(b)).toThrow(ConfigError);
  });

  it("requires the fields of each transport", () => {
    const a = clone();
    delete a.servers.notes.command;
    expect(() => parseConfig(a)).toThrow(ConfigError);
    const b = clone();
    b.servers.ha.url = "ftp://example.com";
    expect(() => parseConfig(b)).toThrow(ConfigError);
    const c = clone();
    c.servers.ha.transport = "carrier-pigeon";
    expect(() => parseConfig(c)).toThrow(ConfigError);
  });

  it("requires wss, allowing ws only for localhost", () => {
    const a = clone();
    a.endpoint = "ws://bridge-ws.martzmakes.com";
    expect(() => parseConfig(a)).toThrow(/wss/);
    const b = clone();
    b.endpoint = "ws://127.0.0.1:9999";
    expect(parseConfig(b).endpoint).toBe("ws://127.0.0.1:9999");
  });

  it("bounds concurrency", () => {
    const a = clone();
    a.servers.notes.concurrency = 0;
    expect(() => parseConfig(a)).toThrow(ConfigError);
    const b = clone();
    b.servers.notes.concurrency = 3;
    expect(parseConfig(b).servers.notes?.concurrency).toBe(3);
  });

  it("classifies a tool named in both lists as write, and an unnamed tool as not exposed", () => {
    const s = { read: ["a", "b"], write: ["b", "c"] };
    expect(accessFor(s, "a")).toBe("read");
    expect(accessFor(s, "b")).toBe("write");
    expect(accessFor(s, "c")).toBe("write");
    expect(accessFor(s, "d")).toBeUndefined();
  });
});

describe("config file", () => {
  let dir: string;
  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "lb-config-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("loads a 0600 file", async () => {
    const path = join(dir, "ok.json");
    await writeFile(path, JSON.stringify(valid), { mode: 0o600 });
    expect((await loadConfig(path)).machine).toBe("mini");
  });

  it("refuses a group- or world-readable file", async () => {
    const path = join(dir, "open.json");
    await writeFile(path, JSON.stringify(valid));
    for (const mode of [0o644, 0o640, 0o604]) {
      await chmod(path, mode);
      await expect(loadConfig(path)).rejects.toThrow(/readable by group or others/);
    }
  });

  it("reports a missing file and bad JSON without echoing content", async () => {
    await expect(loadConfig(join(dir, "nope.json"))).rejects.toThrow(/not found/);
    const path = join(dir, "bad.json");
    await writeFile(path, '{"token": "hunter2-secret", oops', { mode: 0o600 });
    const err = await loadConfig(path).catch((e: Error) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).not.toContain("hunter2");
  });

  it("takes the path from LOCAL_BRIDGE_CONFIG", () => {
    expect(defaultConfigPath({ LOCAL_BRIDGE_CONFIG: "/tmp/x.json" })).toBe("/tmp/x.json");
    expect(defaultConfigPath({})).toMatch(/\.config\/local-bridge\/config\.json$/);
  });
});

describe("keychain references", () => {
  it("resolves keychain: values in headers and env and leaves the rest alone", async () => {
    const fake = fakeSecurity();
    fake.store.set(fake.key("local-bridge.ha-token", userInfo().username), "Bearer tok-123456");
    fake.store.set(fake.key("local-bridge.api", userInfo().username), "env-secret-9");
    const input = clone();
    input.servers.notes.env = { API_KEY: "keychain:local-bridge.api", PLAIN: "value" };
    const { config, secrets } = await resolveSecrets(parseConfig(input), fake.keychain);
    expect(config.servers.ha).toMatchObject({ headers: { Authorization: "Bearer tok-123456" } });
    expect(config.servers.notes).toMatchObject({ env: { API_KEY: "env-secret-9", PLAIN: "value" } });
    expect(secrets.sort()).toEqual(["Bearer tok-123456", "env-secret-9"]);
    // The lookup names the service exactly as the reference spells it.
    expect(fake.calls.some((c) => c.args.includes("local-bridge.ha-token"))).toBe(true);
  });

  it("fails clearly when the item is missing", async () => {
    const fake = fakeSecurity();
    await expect(resolveSecrets(parseConfig(valid), fake.keychain)).rejects.toThrow(/local-bridge\.ha-token.*not found/);
  });
});
