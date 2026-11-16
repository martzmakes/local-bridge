// CLI entry point (bundled to dist/cli.mjs).
import { runCli } from "./commands";

runCli(process.argv.slice(2)).then(
  (code) => {
    if (code !== undefined) process.exit(code);
  },
  (err: unknown) => {
    process.stderr.write(`local-bridge-agent: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(1);
  },
);
