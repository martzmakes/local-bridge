# Decisions

Design decisions and their reasons are in `docs/superpowers/specs/2026-11-15-local-bridge-design.md` (sections 3 and 14). This file records what is not in the spec.

- **2026-11-15, lineage.** Cut from the Skylight repo at `66871fc`, which is `expo-cdk-stack` with Stripe and the paywall removed plus the OAuth fixes Skylight found (the `/oauth/consent` route, the refresh-token reuse-grace window). Skylight's own modules, its custody sync and the template's MCP Apps widgets were left out.
- **2026-11-15, OAuth handler change.** The template's handler now binds a grant to a bridge agent from the RFC 8707 `resource` parameter and carries it as an `agent:<id>` scope entry. A client cannot pick its agent through `scope`: client-supplied `agent:` entries are stripped. If this is ported back to the template, keep that stripping.
- **2026-11-15, the web session JWT is not a bridge credential.** `mintJwt(email)` without an `agent` claim (the SPA sign-in and the SSO cookie) is rejected by `/mcp`. Only OAuth grants and `scripts/mint.ts` produce tokens with an agent.
- **2026-11-15, `jest` `isolatedModules`.** Inherited from the template; ts-jest prints a deprecation warning for it. Harmless, left as is to stay in step with the template.
