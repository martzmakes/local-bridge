const path = require("path");

module.exports = {
  testEnvironment: "node",
  roots: ["<rootDir>/test"],
  testMatch: ["**/*.test.ts"],
  setupFiles: ["<rootDir>/test/jest.setup.ts"],
  transform: {
    // ts-jest compiles to CommonJS, where the repo's `module: NodeNext`
    // default-import of the CJS `qrcode` package (oauth/handler.ts) is only
    // legal with esModuleInterop. Test-only override; the build tsconfig is
    // unchanged.
    // isolatedModules: true — ts-jest's per-file transpile (unlike `tsc
    // --noEmit`, which passes cleanly) fails to resolve packages that use a
    // subpath "exports" map (e.g. cdk-stripe-events/runtime) under NodeNext
    // moduleResolution, erroring TS2307 on any test importing such a module
    // — which silently kills whole suites. esModuleInterop keeps the CJS
    // `qrcode` default-import in oauth/handler.ts legal in ts-jest's
    // CommonJS output. Neither affects the real build or the Lambda bundle.
    "^.+\\.tsx?$": [
      "ts-jest",
      { isolatedModules: true, tsconfig: { esModuleInterop: true } },
    ],
    // jose v6 ships ESM-only (no CJS build) — transpile it (and only it)
    // with Babel so ts-jest tests can require it. See babel.config.jose.js.
    "node_modules/jose/.+\\.js$": [
      "babel-jest",
      { configFile: path.join(__dirname, "babel.config.jose.js") },
    ],
  },
  transformIgnorePatterns: ["node_modules/(?!(jose)/)"],
};
