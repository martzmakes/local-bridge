import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { userInfo } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { INSPECT_TIMEOUT_ERROR, InspectResultSchema, inspectFromText, inspectServer, suggestAccess } from "../src/inspect";
import { FIXTURE, fakeSecurity } from "./helpers";

const stdio = (...extra: string[]) => ({ transport: "stdio", command: process.execPath, args: [FIXTURE, ...extra] });

describe("suggestAccess", () => {
  it("suggests read only on a positive sign with nothing against it", () => {
    for (const name of ["get_note", "list_notes", "search_notes", "read_file", "find_thing", "GET_NOTE", "List_Notes"]) {
      expect(suggestAccess(name)).toBe("read");
      expect(suggestAccess(name, {})).toBe("read");
      expect(suggestAccess(name, { destructiveHint: false })).toBe("read");
    }
    expect(suggestAccess("anything", { readOnlyHint: true })).toBe("read");
    for (const name of ["getnote", "get", "listing", "create_note", "do_get_note", "GetLiveContext", "fetch_x", ""]) {
      expect(suggestAccess(name)).toBe("write");
    }
  });

  it("never suggests read against a contrary annotation", () => {
    expect(suggestAccess("get_note", { destructiveHint: true })).toBe("write");
    expect(suggestAccess("get_note", { readOnlyHint: false })).toBe("write");
    expect(suggestAccess("peek", { readOnlyHint: true, destructiveHint: true })).toBe("write");
    // Only a real boolean counts as a hint.
    expect(suggestAccess("peek", { readOnlyHint: "true" })).toBe("write");
  });
});

describe("inspect", () => {
  const keychain = fakeSecurity().keychain;

  it("lists every tool the fixture offers, across pages, exposed by a config or not", async () => {
    const result = await inspectServer(stdio(), { keychain });
    expect(InspectResultSchema.safeParse(result).success).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.tools.map((t) => t.name)).toEqual([
      "echo",
      "big",
      "slow",
      "crash",
      "boom",
      "automation_denied",
      "automation_thrown",
      "disk_denied",
      "write_thing",
      "hidden",
    ]);
    expect(result.tools[0]).toMatchObject({ name: "echo", description: "Returns its text argument", suggestedAccess: "write" });
    // Nothing about the fixture's plain tools says "read".
    expect(result.tools.every((t) => t.suggestedAccess === "write" && !("readOnlyHint" in t))).toBe(true);
  });

  it("suggests access from annotations and names", async () => {
    const result = await inspectServer(stdio("--inspect-tools"), { keychain });
    if (!result.ok) throw new Error(result.error);
    const byName = Object.fromEntries(result.tools.map((t) => [t.name, t]));
    expect(result.tools).toHaveLength(17);
    expect(byName.get_thing).toMatchObject({ name: "get_thing", description: "Read by name only", suggestedAccess: "read" });
    expect(byName.List_Things).toMatchObject({ suggestedAccess: "read" });
    expect(byName.peek).toMatchObject({ name: "peek", description: "Read by annotation only", readOnlyHint: true, suggestedAccess: "read" });
    expect(byName.search_and_destroy).toMatchObject({ name: "search_and_destroy", description: "Named like a read, marked destructive", suggestedAccess: "write" });
    expect(byName.find_and_fix).toMatchObject({ readOnlyHint: false, suggestedAccess: "write" });
    expect(byName.wipe).toMatchObject({ readOnlyHint: true, suggestedAccess: "write" });
    // No description from the server: an empty string, so the field is always there.
    expect(byName.getter).toMatchObject({ name: "getter", description: "", suggestedAccess: "write" });
  });

  it("accepts a full config entry and ignores read, write, enabled and title", async () => {
    const result = await inspectServer(
      { ...stdio(), title: "Fixture", enabled: false, read: ["echo"], write: ["write_thing"], concurrency: 2 },
      { keychain },
    );
    if (!result.ok) throw new Error(result.error);
    expect(result.tools).toHaveLength(10);
  });

  it("reports bad input", async () => {
    expect(await inspectFromText("{nope", { keychain })).toEqual({ ok: false, error: "invalid server: stdin is not JSON" });
    for (const input of [null, [], {}, { transport: "stdio" }, { transport: "pigeon", url: "http://x" }, { ...stdio(), reads: [] }]) {
      const result = await inspectServer(input, { keychain });
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/^invalid server: /);
      expect(InspectResultSchema.safeParse(result).success).toBe(true);
    }
  });

  it("reports a command that does not exist, and one that exits at once", async () => {
    expect(await inspectServer({ transport: "stdio", command: "/nonexistent/server" }, { keychain })).toEqual({
      ok: false,
      error: "could not start: ENOENT",
    });
    const exited = await inspectServer({ transport: "stdio", command: process.execPath, args: ["-e", "process.exit(3)"] }, { keychain });
    expect(exited.ok).toBe(false);
    if (!exited.ok) expect(exited.error).toMatch(/^could not start: /);
  });

  it("times out on a server that never answers, and stops it", async () => {
    const started = Date.now();
    const result = await inspectServer(stdio("--hang"), { keychain, timeoutMs: 300 });
    expect(result).toEqual({ ok: false, error: INSPECT_TIMEOUT_ERROR });
    expect(result).toEqual({ ok: false, error: "timed out starting the server" });
    // 300 ms to give up, then the SDK's stdin-close and SIGTERM steps.
    expect(Date.now() - started).toBeLessThan(8_000);
  });

  describe("keychain references", () => {
    let server: Server | undefined;
    afterEach(async () => {
      await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
      server = undefined;
    });

    it("resolves keychain: values like the daemon does, and keeps them out of the error", async () => {
      const seen: Array<string | undefined> = [];
      server = createServer((req, res) => {
        seen.push(req.headers.authorization);
        res.writeHead(500, { "content-type": "text/plain" });
        res.end(`no: ${req.headers.authorization}`);
      });
      await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
      const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/mcp`;

      const fake = fakeSecurity();
      fake.store.set(fake.key("local-bridge.test-token", userInfo().username), "Bearer sekrit-token-123");
      const result = await inspectServer(
        { transport: "http", url, headers: { Authorization: "keychain:local-bridge.test-token" } },
        { keychain: fake.keychain, timeoutMs: 5_000 },
      );
      expect(seen[0]).toBe("Bearer sekrit-token-123");
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(/^could not start: /);
        expect(result.error).not.toContain("sekrit");
        expect(result.error.length).toBeLessThanOrEqual(220);
      }
    });

    it("fails with the item's name when the Keychain has no such value", async () => {
      const result = await inspectServer(
        { transport: "http", url: "http://127.0.0.1:9/mcp", headers: { Authorization: "keychain:local-bridge.absent" } },
        { keychain: fakeSecurity().keychain },
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toMatch(/local-bridge\.absent.*not found/);
    });
  });
});
