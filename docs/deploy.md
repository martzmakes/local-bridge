# Deploy

Local only, no GitHub Actions. See [`setup.md`](setup.md) sections 2 and 3.

A Lambda-only change needs just the `cdk deploy`. A change to `infra/lib/shared/protocol.ts` changes both sides: deploy the stack, then rebuild and restart the agent on each Mac (`cd agent && npm run build && launchctl kickstart -k gui/$(id -u)/com.martzmakes.local-bridge`). Keep protocol changes backward compatible for one deploy so the order does not matter.
