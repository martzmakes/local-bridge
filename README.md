# Local Bridge

Remote MCP server at `https://bridge.martzmakes.com/mcp` that lets cloud-hosted agents (Claude channels, ChatGPT, Codex) use MCP servers that only run on my Macs: Apple Notes, Messages, Reminders, Home Assistant, and any other local stdio server.

The Mac dials out to AWS over one WebSocket. No inbound ports, no VPN. Nothing is reachable until it is allowed twice: in the per-agent allowlist in DynamoDB, and in the config file on the Mac.

- Design: [`docs/superpowers/specs/2026-11-15-local-bridge-design.md`](docs/superpowers/specs/2026-11-15-local-bridge-design.md)
- Plan and status: [`docs/superpowers/plans/2026-11-15-local-bridge.md`](docs/superpowers/plans/2026-11-15-local-bridge.md)
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
| `agent/` | The daemon that runs on a Mac under launchd |
| `app/` | Sign-in landing page (the template's Expo app) |

## Connecting an agent

Each agent has its own URL and its own allowlist.

- `https://bridge.martzmakes.com/mcp` is the agent `connector`.
- `https://bridge.martzmakes.com/mcp/a/<agent>` is the agent `<agent>`.

Add the URL as a custom connector and sign in with the magic link, or for clients that take a static header, mint a token:

```bash
cd infra && AWS_PROFILE=your-profile npm run mint -- people --days 90
```

A new agent can call nothing. Grant tools one at a time, see [`docs/operations.md`](docs/operations.md).

## Tests

```bash
cd infra && npx tsc --noEmit && npx jest
cd agent && npx tsc --noEmit && npm test
```
