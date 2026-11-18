# Local Bridge v2: macOS app and one MCP endpoint per local server

Date: 2026-11-15. Extends `2026-11-15-local-bridge-design.md`; where the two differ, this one wins. Matt asked for the app and the per-server endpoints and chose the access model ("the app is the control"). The rest is marked **(my call)**.

> Connector URLs changed after this design was written. See [Upgrading from named connector URLs](../../operations.md#upgrading-from-named-connector-urls) for the current route and rollout.

## 1. Intent

Managing the bridge by editing a JSON file and running a CLI is the wrong shape. Matt wants a macOS app where he adds and manages local MCP servers, and each one becomes its own remote MCP server with its own URL and its own tools, exactly as the local server defines them. A straight-through proxy. One sign-in works for all of them.

### Goals

- Add, edit, remove, enable and disable local MCP servers from a macOS app, with no file editing.
- Each local server is its own remote MCP endpoint: `https://bridge.martzmakes.com/mcp/<machine>/<server>`. Tool names, descriptions and schemas pass through unchanged.
- Shared auth: the same magic-link sign-in and the same tokens work on every endpoint.
- The app decides what each endpoint exposes: a switch per tool, write tools off until switched on.
- The app shows whether the bridge is connected, whether each server is up, and each endpoint's URL to copy.

### Non-goals

- Managing scoped agent tokens and their rules from the app. That stays in `infra/scripts/admin.ts`; it needs AWS admin credentials the app should not hold.
- Bundling Node inside the app, notarization, auto-update. Listed in section 8.
- Windows or Linux.

### Anti-goals

- An endpoint that exposes a write tool nobody switched on.
- Tool names rewritten by the proxy. If the local server calls it `search_notes`, the endpoint calls it `search_notes`.
- Losing the content-free audit trail or the fail-fast offline behaviour.

## 2. Approaches

### 2.1 Access model (Matt's choice)

| | What controls access |
|---|---|
| **App is the control (picked)** | The app's per-tool switches decide what an endpoint exposes. The owner's sign-in sees everything exposed. Scoped tokens can still be narrowed with rules. |
| Pure pass-through | Every tool of every added server is live for any valid token. |
| Per-agent allowlist everywhere | As v1: every agent needs explicit grants, even the owner. |

### 2.2 The app and the daemon **(my call)**

- **Swift app supervising the existing Node daemon (picked).** The daemon already works and has 79 tests. The app spawns it as a child process, so macOS attributes Automation, Reminders and Full Disk Access to the signed app instead of to `node`. This removes v1's biggest permissions weakness.
- Rewrite the daemon in Swift: one process and no Node dependency, but it throws away tested code and the MCP SDK client.
- Keep the LaunchAgent and make the app a config editor only: simplest, but permissions stay attached to `node`.

The app finds a system `node` (configurable path). The LaunchAgent from v1 is retired; the app registers itself as a login item instead. Running both would be two connections fighting for one machine id, so the app refuses to start the daemon while the LaunchAgent is loaded and offers the uninstall command.

### 2.3 URL shape **(my call)**

`/mcp/<machine>/<server>`. It stays under `/mcp`, which CloudFront already proxies. The machine is in the path because the same server name will exist on `air` and `mini`. The aggregate endpoint `/mcp` stays, with the namespaced names (`mini__notes__search_notes`), for a client that wants everything in one connector.

## 3. Cloud changes

**Routing.** `POST /mcp/{machine}/{server}` goes to the MCP Lambda. The endpoint lists and calls only that server's tools, by their original names. `bridge_health` is on every endpoint. `initialize` returns the server's title from the app (`Notes (mini)`).

An endpoint for a server that is not registered returns a JSON-RPC error after authentication, so an unauthenticated caller cannot probe for names.

**Auth, shared.** One OAuth authorization server and one JWT secret, as before. Each endpoint URL is its own protected resource with its own metadata document (`/.well-known/oauth-protected-resource/mcp/<machine>/<server>`), all pointing at the same authorization server. A token is valid on every endpoint. With the session cookie from the first sign-in, adding the next connector is one consent click.

**The owner.** A connector sign-in is the built-in agent `owner`. The owner is allowed every tool a machine announces. No DynamoDB rules are involved; what a machine announces is exactly what the app has switched on. The owner still has rate and size limits (the defaults, overridable with `admin.ts agent create owner ...`) and every call is audited.

**Scoped tokens.** `mint.ts` tokens for other agents work as in v1: default deny, rules per tool, write needs an exact write rule. They work on per-server endpoints too, and see only what their rules grant on that server.

**Removed from v1.** The per-agent connector URLs (`/mcp/a/<agent>`) and the `agent:<id>` scope binding. Per-server endpoints do the same job more simply: the people channel gets the Messages connector and the coach channel does not.

## 4. Machine config (written by the app)

`~/.config/local-bridge/config.json`, same file, three additions:

```jsonc
{
  "machine": "mini",
  "endpoint": "wss://bridge-ws.martzmakes.com",
  "publicBase": "https://bridge.martzmakes.com",   // new, for showing endpoint URLs
  "servers": {
    "notes": {
      "title": "Apple Notes",                       // new, shown to clients and in the app
      "enabled": true,                              // new, false = not started, not announced
      "transport": "stdio",
      "command": "/usr/local/bin/node",
      "args": ["/Users/example/dev/apple-notes-mcp/dist/index.js"],
      "read":  ["list_folders", "list_notes", "get_note", "search_notes"],
      "write": []
    }
  }
}
```

A tool is exposed only if it is in `read` or `write`. The app's per-tool switch moves a tool in or out of those lists; its "can change things" flag picks which list.

The wire protocol gains one optional field: `ServerInfo.title`. Old daemons and the new cloud, or the reverse, keep working.

## 5. Daemon interface for the app

File-based, so the app and the daemon stay decoupled.

**`cli.mjs inspect`** reads one server object (the shape above, `read`/`write` ignored) as JSON on stdin, starts it, lists every tool it offers, stops it, and prints one JSON line:

```json
{"ok":true,"tools":[{"name":"search_notes","description":"...","readOnlyHint":true,"suggestedAccess":"read"}]}
{"ok":false,"error":"could not start: ENOENT"}
```

`suggestedAccess` is `read` only when the server marks the tool `readOnlyHint: true` or its name starts with `get_`, `list_`, `search_`, `read_`, `find_`; otherwise `write`. It is a suggestion for the switch's default, and write-suggested tools start switched off. Times out after 20 s.

**Status file.** `run` writes `~/Library/Application Support/local-bridge/status.json` atomically on every state change and at least every 15 s:

```json
{"pid":123,"version":"0.2.0","machine":"mini","updatedAt":1731700000000,
 "connection":{"state":"connected","since":1731699000000,"lastError":null},
 "servers":[{"name":"notes","title":"Apple Notes","status":"up","error":null,
             "tools":[{"name":"search_notes","access":"read"}]}],
 "calls":{"total":12,"failed":1,"lastAt":1731699990000,"lastTool":"notes.search_notes","lastOutcome":"ok"}}
```

`connection.state` is `connecting`, `connected` or `offline`. The file is removed on clean exit. A reader treats a file older than 45 s, or one whose pid is not running, as "not running". No arguments or results ever go in it.

**Config reload.** The app restarts the daemon after saving the config. In-flight calls fail with the normal offline error; that is acceptable for a settings change.

**`cli.mjs pubkey`** and **`init`** are unchanged. The app shows the public key and the registration command when the machine has not been registered.

## 6. The app

SwiftUI, macOS 14 or later, bundle id `com.martzmakes.localbridge`, signed with Developer ID (team EXAMPLETEAM), hardened runtime with the Apple Events entitlement. Built with SwiftPM plus a script that assembles and signs the `.app`; no Xcode project to maintain **(my call)**.

Menu bar item (icon shows connected, connecting, offline):

```
● Local Bridge: connected as mini
  Apple Notes      up    4 tools
  Messages         up    6 tools
  Home Assistant   down  token rejected
  ─────────────
  Open Local Bridge…
  Pause bridge
  Quit
```

Main window, sidebar of servers and a detail pane:

```
┌──────────────────┬───────────────────────────────────────────────┐
│ ● Apple Notes    │ Apple Notes                       [Enabled ✓]  │
│ ● Messages       │ https://bridge.martzmakes.com/mcp/mini/notes ⧉ │
│ ○ Home Assistant │ Status: up, 4 of 6 tools exposed               │
│                  │                                                │
│                  │ Command  /usr/local/bin/node                   │
│                  │ Args     …/apple-notes-mcp/dist/index.js       │
│                  │                                                │
│                  │ Tools                          [Refresh tools] │
│                  │  ✓ search_notes   Search Apple Notes by text…  │
│                  │  ✓ get_note       Get a note's content…        │
│                  │  ☐ create_note    Create a note…    ⚠ changes  │
│ [+] [−]          │                               [Revert] [Save]  │
└──────────────────┴───────────────────────────────────────────────┘
```

- **Add server**: name (becomes the URL segment, `[a-z0-9]{1,16}`), title, transport. For stdio: command, arguments, environment. For SSE or HTTP: URL and headers, with a "store in Keychain" option for header values that writes a `keychain:` reference. Then "Refresh tools" runs `inspect` and fills the tool list.
- **Tools**: one switch each. Tools suggested as write are off by default, carry a warning mark, and switching one on asks for confirmation once.
- **Save** validates, writes the config (0600, atomic), restarts the daemon.
- **Settings**: machine name, node path, cloud endpoint, launch at login, the device public key with the registration command, and a permissions pane listing what each configured server needs with buttons that open the right System Settings page.
- **Activity**: the last calls from the daemon log (time, server, tool, outcome, duration). No content, because the log has none.

Info.plist carries the usage strings macOS shows in its prompts (`NSAppleEventsUsageDescription`, `NSRemindersFullAccessUsageDescription`, `NSContactsUsageDescription`), since the app is now the process asking.

## 7. Failure modes added

| Situation | Behaviour |
|---|---|
| `node` not found | The app says so and opens Settings on the node path. Nothing starts. |
| v1 LaunchAgent still loaded | The app does not start a second daemon; shows the uninstall command. |
| Daemon exits | Restart with backoff (1 s to 60 s); menu shows offline with the last error class. |
| Machine not registered (auth refused on connect) | The app shows the public key and the registration command. |
| Config on disk is invalid | The app opens it read-only with the validation error and does not overwrite it until fixed. |
| Client calls an endpoint whose server was removed or disabled | Tool error: `mini/notes is not available`, plus `bridge_health`. |

## 8. Later

Bundled, signed Node so nothing depends on Homebrew. Notarization and a DMG. Agents and rules pane backed by a narrow admin API instead of AWS credentials. Per-call confirmation for write tools as a notification from the app.

## 9. Accounts (added the same evening, at Matt's direction)

The app and the cloud are per user. Signing in to the app on several Macs with the same email puts all of those Macs in one account. A different user has a separate account and cannot see or reach anyone else's machines, servers, endpoints, agents or audit rows.

### 9.1 Identity

- A user is an email that completed the magic-link sign-in. The account id is `uid = first 20 hex characters of sha256(lowercased email)`. It is derived, so there is no user-to-account lookup to get wrong.
- Who may sign in is still the `ALLOWED_EMAILS` gate in the stack **(my call)**. The system is multi-user; the door is opened by adding emails there. Opening it to anyone is a product decision (cost, abuse, support), not a default.
- Every bridge JWT has `sub` = email; the tenant of a request is always derived from the verified token, never from the URL or the body.

### 9.2 Tenancy in the data model

Everything in `BridgeTable` that belonged to "the" owner is now keyed by account:

| was | is |
|---|---|
| `AGENTS` | `AGENTS#<uid>` |
| `MACHINES` | `MACHINES#<uid>` |
| `RATE#<agent>` | `RATE#<uid>#<agent>` |
| `AUDIT#<day>` | `AUDIT#<uid>#<day>` |
| `CONN#<connectionId>` | unchanged key; carries `uid` and `machine` |
| `CALL#<callId>` | unchanged key; carries `uid` and `machine`, and a result is accepted only from that account's machine |
| `JTI#<machine>:<jti>` | `JTI#<uid>:<machine>:<jti>` |

Machine names are per account: two users can each have a `mini`.

### 9.3 Endpoints

URLs do not change: `/mcp/<machine>/<server>` and `/mcp`. They resolve inside the account of the token that calls them. `mini/notes` with Matt's token is Matt's Notes; with another user's token it is that user's `mini`, or "not available". URLs carry no account id, so they reveal nothing and cannot be used to probe another account **(my call)**.

### 9.4 The app signs in and registers its Mac

This replaces `admin.ts device register`.

1. First run: the app registers itself as an OAuth client (`POST /oauth/register`, redirect `localbridge://oauth/callback`) and keeps the client id.
2. Sign in: the app opens the browser at `/oauth/authorize` with PKCE (`S256`), `state`, and `resource=<publicBase>/mcp`. The user enters their email and clicks the magic link; the browser is redirected to `localbridge://oauth/callback?code=…&state=…`, which opens the app. The app exchanges the code at `/oauth/token` and stores the access and refresh tokens in its own Keychain item. Refresh tokens rotate: store the new one from every refresh.
3. The app runs `cli.mjs init` (creates the device key if missing) and `cli.mjs pubkey`, then registers this Mac.

Account API, bearer token from a connector-style sign-in only (kind `oauth`), all under `/api`:

| | |
|---|---|
| `GET /api/me` | `{ "email", "uid" }` |
| `GET /api/machines` | `{ "machines": [{ "machine", "enabled", "connected", "lastSeen", "agentVersion", "kids": [], "servers": [{ "name", "title", "status", "tools": 4 }] }] }` |
| `PUT /api/machines/<machine>` body `{ "jwk": { "kty":"OKP","crv":"Ed25519","x":"…" } }` | registers or replaces this account's key for that machine; returns `{ "uid", "machine", "kid" }` |
| `DELETE /api/machines/<machine>` | removes the machine and its servers from the account; its open connection stops receiving calls |

Errors are `{ "error": "<code>", "message": "…" }` with 400, 401, 404 or 409 (`machine_limit`: 10 machines per account).

4. The app writes `"account": "<uid>"` into the daemon config and starts the daemon.

### 9.5 Machine channel

The device assertion gains a `uid` claim. The authorizer looks the key up under that account's machine; a valid signature for a machine name in another account does not match, because the key is not registered there. An assertion without `uid` is refused. `hello.machine` must still equal the machine the connection authenticated as.

### 9.6 The app, added

- Signed out: a sign-in screen and nothing else. No daemon runs.
- Signed in: the account email in Settings with Sign out (stops the daemon, deletes the tokens; the device key stays) and a Machines list from `GET /api/machines` showing every Mac on the account, which one is this Mac, and Remove.
- If the config has no `account`, or the cloud refuses the connection, the app re-registers the Mac itself instead of showing a command to paste.

### 9.7 Release

Signed and notarized the way Tower is (`~/dev/agent-mission-control/Scripts/release-mac.sh`): Developer ID Application (team EXAMPLETEAM), hardened runtime, secure timestamp, `notarytool submit --wait` with the App Store Connect API key when `~/.appstoreconnect/private_keys/AuthKey_<id>.p8` is present and otherwise the keychain profile `local-bridge-notary`, then `stapler staple`, `stapler validate` and `spctl --assess`. No Sparkle feed yet.

### 9.8 Migration

The `mini` row registered through the CLI on 2026-11-15 predates accounts and is deleted. The mini rejoins by signing in through the app. `admin.ts` and `mint.ts` take `--user <email>` and default to the first allowed email.
