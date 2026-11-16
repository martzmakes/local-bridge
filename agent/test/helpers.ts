import { fileURLToPath } from "node:url";
import type { ServerConfig } from "../src/config";
import { Keychain, type SecurityRunner } from "../src/keychain";

export const FIXTURE = fileURLToPath(new URL("./fixtures/fixture-server.mjs", import.meta.url));

export function fixtureServer(overrides: Partial<Extract<ServerConfig, { transport: "stdio" }>> = {}): ServerConfig {
  return {
    transport: "stdio",
    command: process.execPath,
    args: [FIXTURE],
    read: ["echo", "big", "slow", "crash", "boom", "automation_denied", "automation_thrown", "disk_denied"],
    write: ["write_thing"],
    concurrency: 1,
    enabled: true,
    ...overrides,
  };
}

function unquote(token: string): string {
  return token.replace(/\\(["\\])/g, "$1");
}

/** An in-memory stand-in for /usr/bin/security that records every invocation. */
export function fakeSecurity() {
  const store = new Map<string, string>();
  const calls: Array<{ args: string[]; stdin?: string }> = [];
  const key = (service: string, account: string) => `${service}\u0000${account}`;
  const flag = (args: string[], name: string) => args[args.indexOf(name) + 1] ?? "";
  const runner: SecurityRunner = async (args, stdin) => {
    calls.push({ args: [...args], ...(stdin !== undefined ? { stdin } : {}) });
    if (args[0] === "-i") {
      const m = /^add-generic-password -U -s "((?:[^"\\]|\\.)*)" -a "((?:[^"\\]|\\.)*)" -w "((?:[^"\\]|\\.)*)"\n$/.exec(stdin ?? "");
      if (!m) return { code: 0, stdout: "", stderr: "fake security: could not parse command" };
      store.set(key(unquote(m[1]!), unquote(m[2]!)), unquote(m[3]!));
      return { code: 0, stdout: "", stderr: "" };
    }
    const k = key(flag(args, "-s"), flag(args, "-a"));
    if (args[0] === "find-generic-password") {
      const value = store.get(k);
      return value === undefined ? { code: 44, stdout: "", stderr: "not found" } : { code: 0, stdout: value + "\n", stderr: "" };
    }
    if (args[0] === "delete-generic-password") {
      return store.delete(k) ? { code: 0, stdout: "", stderr: "" } : { code: 44, stdout: "", stderr: "not found" };
    }
    return { code: 2, stdout: "", stderr: "unsupported" };
  };
  return { runner, store, calls, keychain: new Keychain(runner), key };
}

export async function waitFor<T>(probe: () => T | undefined | false | null, timeoutMs = 10_000, label = "condition"): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

export function capturingLogger() {
  const lines: string[] = [];
  const emit = (level: string) => (event: string, fields: Record<string, unknown> = {}) => {
    lines.push(JSON.stringify({ level, event, ...fields }));
  };
  return { lines, log: { info: emit("info"), warn: emit("warn"), error: emit("error") } };
}
