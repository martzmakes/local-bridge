# Auth — magic link + JWT

## Flow

```
1. User enters email in SignInScreen
2. Client → POST /auth/request { email }
3. Lambda writes one-shot token (15-min TTL) to MagicLinkTokensTable
4. Lambda sends SES email containing https://<auth-api>/auth/verify?token=…
5. User taps link in email → browser hits /auth/verify
6. Lambda consumes the token (one-shot), upserts user, mints JWT (HS256, 30-day)
7. Lambda returns HTML that redirects to https://bridge.martzmakes.com/play?jwt=…
8. Client picks up jwt from URL via expo-linking, stores it, calls GET /auth/me
9. JWT is sent as Authorization: Bearer <jwt> on subsequent requests
```

## JWT details

- **Algorithm**: HS256 (symmetric, signed with SSM SecureString `/local-bridge/jwt-secret`).
- **Issuer**: `bridge.martzmakes.com`
- **Audience**: `local-bridge_app`
- **TTL**: 30 days.
- **Library**: [`jose`](https://github.com/panva/jose) (works in Lambda + browser).
- **Subject**: user email (lowercased, trimmed).

## Storage on the client

`app/src/hooks/useAuth.ts` handles platform-specific storage:

| Platform | Primary | Fallback |
|---|---|---|
| Web (browser tab) | `localStorage` | cookie (for iOS standalone PWA) |
| iOS / Android | `expo-secure-store` | — |

The iOS PWA cookie fallback exists because iOS Safari doesn't share `localStorage` with a standalone-installed PWA, but cookies *are* shared.

## Deep links

The verify HTML redirect uses two formats so it works for web *and* native:

- Web: `https://bridge.martzmakes.com/play?jwt=…`
- Native: `local-bridge://auth/complete?jwt=…` (or universal link `https://bridge.martzmakes.com/auth/complete?jwt=…` if AASA is configured)

`expo-linking.addEventListener("url", …)` catches both. `Linking.getInitialURL()` handles the cold-start case (app launched from the link).

## Universal Links / App Links

Already configured in `app/app.json` and `app/public/.well-known/`:

- iOS: `apple-app-site-association` covers `/auth/complete*`. Update `appIDs` to `<TeamID>.<bundleId>`.
- Android: `assetlinks.json` is a stub — fill in once you have a signing cert SHA-256.

## Account deletion

`DELETE /auth/me` removes the user row from `UsersTable`. For privacy compliance you should also clear any other tables that key off the user's email — add those deletes to `me.ts` as you build them.

## Security notes

- `/auth/request` always returns 200 — no user enumeration.
- Tokens are one-shot: the row is deleted on first use even if JWT minting fails afterward (consume-before-mint pattern).
- TTL on `MagicLinkTokensTable` auto-purges stale tokens — DynamoDB does the GC for free.
- `/auth/verify` returns `cache-control: no-store` so the JWT-bearing page never caches.
- The HTML response embeds the JWT in a `<script>window.location.replace(…)</script>` — risky if the email field is ever rendered into HTML upstream. We never do that, but if you add user-controlled content to the verify page, escape it carefully.
