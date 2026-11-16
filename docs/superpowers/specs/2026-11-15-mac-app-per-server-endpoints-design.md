# Local Bridge v2: macOS app and one MCP endpoint per local server

Date: 2026-11-15. Extends `2026-11-15-local-bridge-design.md`; where the two differ, this one wins. Matt asked for the app and the per-server endpoints and chose the access model ("the app is the control"). The rest is marked **(my call)**.

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
