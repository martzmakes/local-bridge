# Local Bridge

Local Bridge connects remote Model Context Protocol (MCP) clients to tools running on your Mac. Use it with local servers for Notes, Messages, and Reminders, or add your own stdio MCP server.

You manage it from the Local Bridge macOS app (`macapp/`): add a local MCP server, switch on the tools you want exposed, and that server becomes its own remote MCP endpoint with its own URL and its own tools, unchanged. One sign-in covers every endpoint.

The Mac dials out to AWS over one WebSocket. A tool is reachable only if you switch it on in the app. Tools that make changes start off. The cloud relay uses API Gateway, Lambda and DynamoDB. [Architecture](https://bridge.martzmakes.com/#how)

## Get started

1. Install the [Mac app](https://bridge.martzmakes.com/updates/LocalBridge-Mac-0.3.1.zip). It needs macOS 14 or newer, Apple silicon, and Node.js 22 or newer.
2. Sign in with an invitation, or deploy the bridge to your AWS account using the [self-hosting guide](docs/self-hosting.md). For self-hosting, choose **Choose Backend… → Self-hosted** before signing in.
3. Add a local MCP server and review the tools you want to share. Copy the server's connector URL and add it in your MCP client.

Hosted signup is [waitlist-only](https://bridge.martzmakes.com/#plans). For AWS usage estimates, see [hosted service costs](docs/hosted-service.md).

- Design: [`v1`](docs/superpowers/specs/2026-11-15-local-bridge-design.md), then [`v2: the app and per-server endpoints`](docs/superpowers/specs/2026-11-15-mac-app-per-server-endpoints-design.md), which wins where they differ
- Plans and status: [`v1`](docs/superpowers/plans/2026-11-15-local-bridge.md), [`v2`](docs/superpowers/plans/2026-11-15-mac-app-per-server-endpoints.md)
- Day-to-day commands: [`docs/operations.md`](docs/operations.md)
- macOS permissions each local server needs: [`docs/permissions.md`](docs/permissions.md)
- First-time setup and deploy: [`docs/setup.md`](docs/setup.md)

## Layout

| Path | What |
|---|---|
| `infra/` | CDK stack `LocalBridgeStack` and its Lambdas |
| `infra/lib/shared/protocol.ts` | Wire protocol between a Mac and the cloud (Zod); imported by both sides |
| `infra/lib/lambdas/bridge/` | Naming, policy, audit, rate limit, device auth, call dispatch, DynamoDB store |
| `infra/lib/lambdas/mcp/` | The `/mcp` endpoint |
| `infra/lib/lambdas/ws/` | WebSocket authorizer and handler for the machine channel |
| `infra/scripts/` | `admin.ts` (agents, rules, machines, audit) and `mint.ts` (agent tokens) |
| `agent/` | The Node daemon that starts the local servers and holds the connection; the app runs it |
| `macapp/` | The macOS app (SwiftUI) that manages servers and supervises the daemon |
| `app/` | Sign-in landing page (the template's Expo app) |

## Connecting an agent

Each local server has its own endpoint. The app shows the URL with a copy button.

- `https://bridge.martzmakes.com/mcp/<uuid>` presents one server’s tools under their own names. The app saves a random UUID for each server. The bridge resolves it within the signed-in account.
- `https://bridge.martzmakes.com/mcp`: every server in one connector, with names like `mini__notes__search_notes`.

Add a URL as a custom connector and sign in with the magic link. The sign-in is shared: after the first one, each further connector is one consent click. A connector sign-in is the owner and sees everything the app exposes on that endpoint.

For a client that takes a static header, or to give an agent less than everything, mint a scoped token:

```bash
cd infra && AWS_PROFILE=your-profile npm run mint -- people --days 90
```

A scoped agent can call nothing until granted, see [`docs/operations.md`](docs/operations.md).

## Tests

```bash
cd infra && npx tsc --noEmit && npx jest
cd agent && npx tsc --noEmit && npm test
cd macapp && swift test
```

## Contributing and security

See [Contributing](CONTRIBUTING.md), the [threat model](docs/threat-model.md), and the [security reporting policy](SECURITY.md).

Local Bridge is licensed under the [MIT License](LICENSE).
