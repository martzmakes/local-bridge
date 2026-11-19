# Contributing to Local Bridge

Start with the [architecture](docs/architecture.md) and [threat model](docs/threat-model.md). For configuration and deployment changes, follow the [self-hosting guide](docs/self-hosting.md) using a separate stack and a test account.

Install the infrastructure dependencies before building or testing the daemon. It imports the shared protocol from `infra/`.

```sh
(cd infra && npm ci && npm run build -- --noEmit && npm test -- --runInBand)
(cd agent && npm ci && npm run typecheck && npm test && npm run build)
(cd app && npm ci && npx tsc --noEmit)
(cd macapp && swift test)
```

In a pull request, describe the user-visible change, the tests you ran, and any effect on configuration, permissions, or data handling. Use synthetic fixtures in screenshots and test output. See the [security policy](SECURITY.md) for vulnerability reports.
