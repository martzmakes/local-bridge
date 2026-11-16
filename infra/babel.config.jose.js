// Minimal Babel config used ONLY by Jest to transpile the ESM-only `jose`
// package (v6 ships no CJS build) so it can be required from ts-jest tests.
// Application/CDK code never goes through Babel — ts-jest handles all .ts.
module.exports = {
  presets: [["@babel/preset-env", { targets: { node: "current" } }]],
};
