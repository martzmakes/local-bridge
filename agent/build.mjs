// Bundles the daemon and the CLI into single ESM files under dist/.
import { build } from "esbuild";
import { chmod } from "node:fs/promises";

const common = {
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: false,
  legalComments: "none",
  // ws probes for these optional native add-ons inside try/catch.
  external: ["bufferutil", "utf-8-validate"],
  // Bundled CommonJS dependencies (ws, cross-spawn) call require() for Node builtins.
  banner: {
    js: [
      "#!/usr/bin/env node",
      "import { createRequire as __lbCreateRequire } from 'node:module';",
      "const require = __lbCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  logLevel: "info",
};

await build({ ...common, entryPoints: { agent: "src/main.ts", cli: "src/cli.ts" }, outdir: "dist", outExtension: { ".js": ".mjs" } });
await chmod("dist/agent.mjs", 0o755);
await chmod("dist/cli.mjs", 0o755);
