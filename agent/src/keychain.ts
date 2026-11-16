// Generic-password access through /usr/bin/security.
//
// Secrets never appear in argv (argv is visible to every process on the
// machine through `ps`): writes go through `security -i` with the command on
// stdin, and reads use `find-generic-password -w`, which prints to stdout.
import { spawn } from "node:child_process";
import { userInfo } from "node:os";

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Runs /usr/bin/security with `args`, optionally feeding `stdin`. Injectable for tests. */
export type SecurityRunner = (args: string[], stdin?: string) => Promise<RunResult>;

export const SECURITY_BIN = "/usr/bin/security";
export const DEVICE_KEY_SERVICE = "com.martzmakes.local-bridge.device-key";
export const DEVICE_KEY_NEXT_SERVICE = `${DEVICE_KEY_SERVICE}.next`;
export const KEYCHAIN_REF_PREFIX = "keychain:";

/** `security` exit status for errSecItemNotFound. */
const NOT_FOUND = 44;
/** `security -i` reads lines into a fixed buffer; stay far below it. */
const MAX_SECRET_LENGTH = 2000;

export const defaultRunner: SecurityRunner = (args, stdin) =>
  new Promise((resolve, reject) => {
    const child = spawn(SECURITY_BIN, args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (d: string) => (stdout += d));
    child.stderr.setEncoding("utf8").on("data", (d: string) => (stderr += d));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code: code ?? 1, stdout, stderr }));
    child.stdin.on("error", () => {});
    child.stdin.end(stdin ?? "");
  });

/** Quotes one token for the `security -i` command parser. */
function quote(value: string): string {
  if (/[\u0000-\u001f\u007f]/.test(value)) throw new Error("keychain values must not contain control characters");
  return `"${value.replace(/[\\"]/g, "\\$&")}"`;
}

function assertName(kind: string, value: string): void {
  if (!/^[A-Za-z0-9._@-]{1,128}$/.test(value)) throw new Error(`invalid keychain ${kind}`);
}

export class Keychain {
  constructor(private readonly run: SecurityRunner = defaultRunner) {}

  /** Returns the stored password, or null when there is no such item. */
  async get(service: string, account: string): Promise<string | null> {
    assertName("service", service);
    assertName("account", account);
    const r = await this.run(["find-generic-password", "-s", service, "-a", account, "-w"]);
    if (r.code === NOT_FOUND) return null;
    if (r.code !== 0) throw new Error(`security find-generic-password failed (exit ${r.code}) for ${service}`);
    return r.stdout.replace(/\r?\n$/, "");
  }

  /** Creates or replaces the item. The secret travels on stdin only. */
  async set(service: string, account: string, secret: string): Promise<void> {
    assertName("service", service);
    assertName("account", account);
    if (secret.length === 0 || secret.length > MAX_SECRET_LENGTH) throw new Error("keychain secret has an unsupported length");
    const command = `add-generic-password -U -s ${quote(service)} -a ${quote(account)} -w ${quote(secret)}\n`;
    const r = await this.run(["-i"], command);
    if (r.code !== 0) throw new Error(`security add-generic-password failed (exit ${r.code}) for ${service}`);
    // `security -i` reports a failed command on stderr but can still exit 0,
    // so confirm by reading the item back.
    if ((await this.get(service, account)) !== secret) {
      throw new Error(`keychain write for ${service} could not be verified`);
    }
  }

  /** Deletes the item. Returns false when it did not exist. */
  async delete(service: string, account: string): Promise<boolean> {
    assertName("service", service);
    assertName("account", account);
    const r = await this.run(["delete-generic-password", "-s", service, "-a", account]);
    if (r.code === NOT_FOUND) return false;
    if (r.code !== 0) throw new Error(`security delete-generic-password failed (exit ${r.code}) for ${service}`);
    return true;
  }

  /** Resolves a `keychain:<service>` config reference (account = the current user). */
  async resolveRef(ref: string): Promise<string> {
    const service = ref.slice(KEYCHAIN_REF_PREFIX.length);
    const value = await this.get(service, userInfo().username);
    if (value === null || value === "") throw new Error(`keychain item "${service}" not found for user ${userInfo().username}`);
    return value;
  }
}

export function isKeychainRef(value: string): boolean {
  return value.startsWith(KEYCHAIN_REF_PREFIX);
}
