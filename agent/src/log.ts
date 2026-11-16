// Structured, content-free logging. Callers pass only metadata fields: ids,
// names, durations, byte counts, error classes. Never arguments or results.
export type LogFields = Record<string, string | number | boolean | undefined>;

export interface Logger {
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
}

export function createLogger(write: (line: string) => void = (l) => process.stdout.write(l + "\n")): Logger {
  const emit = (level: string) => (event: string, fields: LogFields = {}) => {
    write(JSON.stringify({ ts: new Date().toISOString(), level, event, ...fields }));
  };
  return { info: emit("info"), warn: emit("warn"), error: emit("error") };
}

export const silentLogger: Logger = { info() {}, warn() {}, error() {} };

/** The class and code of an error, without its message (messages can quote content). */
export function errorClass(err: unknown): string {
  if (err instanceof Error) {
    const code = (err as { code?: unknown }).code;
    const name = err.name && err.name !== "Error" ? err.name : err.constructor?.name || "Error";
    return typeof code === "string" || typeof code === "number" ? `${name} ${code}` : name;
  }
  return typeof err;
}
