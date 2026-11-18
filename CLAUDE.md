# Local Bridge

Remote MCP server at `https://bridge.martzmakes.com/mcp` that forwards tool calls from cloud agents to MCP servers on Matt's Macs. Cut from `martzmakes/expo-cdk-stack` by way of the Skylight repo (Stripe and paywall removed). Deploys are local; there is no CI by choice.

Read both specs before changing behaviour: `docs/superpowers/specs/2026-11-15-local-bridge-design.md` (v1) and `docs/superpowers/specs/2026-11-15-mac-app-per-server-endpoints-design.md` (v2, wins where they differ). Together they are the source of truth for the security model.

## Security invariants (do not weaken without Matt saying so)

- The Mac's app is the control. A tool exists for the cloud only if it is switched on there (the daemon config's `read`/`write` lists). Write tools start off.
- The built-in agent `owner` (every connector sign-in) may use whatever a machine announces. Every other agent is default deny: with no rule for a tool it cannot list or call it.
- A write tool needs an exact rule with `access: "write"`. A wildcard rule never grants a write tool. `policy.ts` `decide()` and `RuleSchema` both enforce this.
- No message, note or argument content in logs or audit rows. Lambdas log only through `logEvent()` in `bridge/runtime.ts` with scalar ids, sizes and fixed codes. Never log an `err.message` from a local server or a request/response body. Machine error text is replaced by fixed wording in `dispatch.ts` except for codes whose messages the agent composes without content.
- Result filters fail closed: if a rule's filter cannot be applied, the result is withheld.
- A call whose audit row cannot be written returns no data.
- Calls are never queued for an offline machine and never retried by the bridge.
- The device private key never leaves the Mac. AWS holds public keys only.

## Layout

- `infra/lib/infra-stack.ts`: `LocalBridgeStack`.
- `infra/lib/shared/protocol.ts`: wire protocol (Zod). Imported by `agent/` by relative path. Changing it changes both sides.
- `infra/lib/lambdas/bridge/`: `names.ts`, `policy.ts`, `audit.ts`, `ratelimit.ts`, `device-auth.ts`, `dispatch.ts`, `store.ts` (key layout documented at the top), `runtime.ts`.
- `infra/lib/lambdas/mcp/`: `server.ts` (HTTP, auth, JSON-RPC), `bridge.ts` (tools/list, tools/call pipeline, `bridge_health`).
- `infra/lib/lambdas/ws/`: `authorizer.ts` (`$connect`), `handler.ts` (`$connect`, `$disconnect`, `$default`).
- `infra/lib/lambdas/auth/`, `oauth/`: the template's magic link and OAuth 2.1, plus the agent binding in `oauth/handler.ts` (`agentFromResource`, `scopeWithAgent`).
- `infra/scripts/`: `admin.ts`, `mint.ts`, `env.ts`.
- `agent/`: the Node daemon. Its own `package.json`. Interface to the app (`inspect`, `status.json`) is v2 spec section 5.
- `macapp/`: the SwiftUI app. SwiftPM, `LocalBridgeCore` (testable, no UI) and `LocalBridge`. Runs the daemon as a child so macOS privacy grants belong to the signed app.
- `app/`: the template's Expo app, used only as the sign-in landing page.

## Commands

```bash
# Tests and typecheck
cd infra && npx tsc --noEmit && npx jest
cd agent && npx tsc --noEmit && npm test
cd macapp && swift test && ./scripts/build-app.sh

# Deploy (web bundle first if app/ changed; see docs/setup.md)
cd infra && AWS_PROFILE=your-profile AWS_REGION=us-east-1 \
  CDK_DEFAULT_REGION=us-east-1 CDK_DEFAULT_ACCOUNT=123456789012 \
  npx cdk deploy LocalBridgeStack --require-approval never --outputs-file cdk-outputs.json

# Admin
cd infra && AWS_PROFILE=your-profile npm run admin -- --help
cd infra && AWS_PROFILE=your-profile npm run mint -- <agent>
```

## Conventions

- TypeScript strict, Zod at every boundary (HTTP body, WebSocket frame, DynamoDB rule rows, agent config).
- Pure logic (`names`, `policy`, `audit`, `ratelimit`, `dispatch`, `device-auth`, `mcp/bridge`) takes its I/O as injected deps and is tested without AWS. Keep it that way.
- Canonical tool ids are dotted (`mini.notes.search_notes`) in rules, audit and health. On the aggregate `/mcp`, wire names use `__` because Anthropic and OpenAI reject dots in tool names. On a server's own endpoint (`/mcp/<uuid>`) names pass through untouched. Never parse a client-facing name; look it up in the catalog.
- Auth is shared across endpoints: any valid bridge token is accepted on any endpoint, and what it may do there is policy (`authorize()` in `mcp/bridge.ts`).
- JWTs: HS256, SSM `/local-bridge/jwt-secret`. Bridge tokens carry `agent` and `kind`; minted ones also `tv`. A JWT without `agent` (the web session) is not accepted by `/mcp`.
- The MCP Lambda is the template's stateless JSON-RPC handler, with `@modelcontextprotocol/sdk` schemas for validation. The SDK server transport is not used in Lambda; the agent uses the SDK client.

## Gotchas

- API Gateway WebSocket: 32 KB per frame, 10 min idle, 2 h max connection. Machine-to-cloud messages are framed (`encodeFrames`); the agent heartbeats every 60 s and reconnects at 110 min.
- The MCP Lambda waits for a result by polling the `CALL` row with consistent reads. API Gateway cuts HTTP at 30 s, so the call timeout ceiling is 25 s.
- `BridgeTable` is RETAIN with a generated name. After a teardown and redeploy there will be two; point `BRIDGE_TABLE` at the old one or migrate.
- CloudFront `errorResponses` must stay off (see the comment in the stack): it would turn API 404s into 200 + SPA.
- Parent zone and wildcard certificate come from SSM (`/martzmakes/prototype-builder/*`).
