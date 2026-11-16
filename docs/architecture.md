# Architecture

The architecture, data model, auth flows and failure modes are in the design spec: [`superpowers/specs/2026-11-15-local-bridge-design.md`](superpowers/specs/2026-11-15-local-bridge-design.md).

What the stack provisions (`infra/lib/infra-stack.ts`, one stack, `LocalBridgeStack`, us-east-1):

- **CloudFront** on `bridge.martzmakes.com`: the sign-in page from S3, and `/mcp*`, `/oauth/*`, `/auth/*`, `/.well-known/*` proxied to the HTTP API.
- **HTTP API** with the magic-link Lambdas, the OAuth Lambda and the MCP Lambda.
- **WebSocket API** on `bridge-ws.martzmakes.com` with a Lambda authorizer on `$connect` and one handler Lambda. This is the channel each Mac dials out to.
- **DynamoDB**: `BridgeTable` (agents, rules, machines, calls, rate counters, audit) plus the template's `UsersTable`, `MagicLinkTokensTable`, `OAuthTable`, `WaitlistTable`.
- **SSM SecureStrings** (created by hand): `/local-bridge/jwt-secret`, `/local-bridge/audit-hmac-key`.
- **Shared, imported from SSM**: the `martzmakes.com` hosted zone and the `*.martzmakes.com` certificate.

The template's generic notes on the magic-link flow and the MCP/OAuth endpoints are in [`auth.md`](auth.md) and [`mcp.md`](mcp.md). Where they differ from this repo (widgets, the hand-rolled tool catalog), the spec wins.
