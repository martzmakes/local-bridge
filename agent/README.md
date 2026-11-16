# local-bridge-agent

The daemon that runs on each Mac. It starts the local MCP servers named in its
config, opens one outbound WebSocket to the bridge, and runs the tool calls the
cloud forwards. Design: `docs/superpowers/specs/2026-11-15-local-bridge-design.md`
(sections 5.2, 6, 10, 11) and, for what the macOS app uses (`inspect`, the status file,
`title`/`enabled`/`publicBase`/`account`),
`docs/superpowers/specs/2026-11-15-mac-app-per-server-endpoints-design.md` (sections 4, 5, 9).
Wire contract: `infra/lib/shared/protocol.ts`, imported
by relative path and bundled in.

## Build and test

```sh
cd agent
npm install
npx tsc --noEmit
npm test          # offline: no Keychain, no Apple apps, only 127.0.0.1
npm run build     # dist/agent.mjs (daemon) and dist/cli.mjs
```

The protocol file resolves `zod` from `infra/node_modules`, so `infra` needs its
dependencies installed too.

## Set up a machine

The Local Bridge macOS app does all of this: it signs in, writes the config, runs `init`,
registers the public key with the account API, and starts and restarts `run`. By hand:

1. Write `~/.config/local-bridge/config.json` (start from `config.example.json`) and `chmod 600` it.
   The agent refuses a config that group or others can read.
2. `node dist/cli.mjs init` generates the Ed25519 device key if there is none, stores the
   private half in the login Keychain, and prints the public JWK as one JSON line
   (`{"kty","crv","x","kid"}`) and nothing else. The app registers that key with
   `PUT /api/machines/<machine>` and writes the account id into the config as `account`.
3. `node dist/cli.mjs doctor` checks the config, the account, the key and each server, lists
   the exposed tools with their class, lists what each server offers that the config does
   not expose, says which servers are disabled, and prints the permissions table.
4. `node dist/cli.mjs run` runs in the foreground. Approve the Automation prompts at the screen.

Commands: `init`, `pubkey`, `rotate-key`, `doctor`, `inspect`, `run`. All take
`--config <path>`; `LOCAL_BRIDGE_CONFIG` overrides the default path. `init` and `pubkey` take
`--machine <name>` for use before a config exists. `inspect` reads no config at all.

`run` needs `account` in the config. Without it, it starts nothing, writes a status file with
`connection.state` `"offline"` and `lastError` `"no_account"`, prints
`this Mac is not signed in to an account; open the Local Bridge app and sign in` on stderr
and exits 1. `doctor` reports the same as a failed check. `init`, `pubkey` and `inspect` do
not need an account.

## Config

A tool reaches the cloud only if it is named under `read` or `write`. A name in both lists
is `write`. Anything the server offers that is not named stays invisible, including tools
that appear after a server upgrade. Unknown keys are rejected, so a typo such as `"reads"`
is an error instead of an empty allowlist.

| Field | Meaning |
|---|---|
| `machine` | `[a-z0-9]{1,16}`; must match the name registered in the cloud |
| `endpoint` | `wss://` URL (`ws://` only for localhost) |
| `publicBase` | optional `https://` URL, default `https://bridge.martzmakes.com`; the app builds the endpoint URLs it shows from it. The agent never connects to it |
| `account` | optional in the file, required by `run`: 20 lowercase hex characters, written by the app after sign-in; sent as the `uid` claim of the device assertion |
| `servers.<name>` | `[a-z0-9]{1,16}`; this name, not the server's own, appears in tool ids |
| `title` | optional, 1 to 64 characters; shown to MCP clients and in the app, announced in `hello` |
| `enabled` | optional, default `true`. `false`: the server is not started, not announced, not in the status file, its `keychain:` values are not looked up, and calls to it get `not_exposed` |
| `transport` | `stdio` (`command`, `args`, `env`, `cwd`), `sse` or `http` (`url`, `headers`) |
| `read`, `write` | tool names to expose, by access class |
| `concurrency` | calls at once for this server, default 1, at most 4 |
| `callTimeoutMs` | optional cap for one call, on top of the cloud's deadline |

Any `env` or `headers` value of the form `keychain:<service>` is replaced at start with the
generic password stored under exactly that service name for the current user. Store one
without the secret touching your shell history:

```sh
security add-generic-password -U -s local-bridge.ha-token -a "$USER" -w
# paste the value at the prompt; for Home Assistant include the scheme: "Bearer <token>"
```

### The other servers (milestone 2 and 3)

`config.example.json` enables `notes` only. These are the blocks to add under `servers`
when each one's turn comes. Tool names were read from each server's `src/index.ts`; run
`doctor` after adding one, since it shows what the server really offers.

```jsonc
// Messages: imessage-mcp has six tools and all of them read. There is no send tool.
// Needs Full Disk Access (chat.db, AddressBook) and Automation for Contacts.
"messages": {
  "transport": "stdio",
  "command": "/usr/local/bin/node",
  "args": ["/Users/example/dev/imessage-mcp/dist/index.js"],
  "read": ["list_contacts", "list_conversations", "get_conversation",
           "search_messages", "get_message_stats", "get_attachments"],
  "write": []
},

// Reminders: three read tools, seven that change or delete.
// Needs the Reminders permission; doctor calls list_reminder_lists to prove it is granted.
"reminders": {
  "transport": "stdio",
  "command": "/usr/local/bin/node",
  "args": ["/Users/example/dev/apple-reminders-mcp/dist/index.js"],
  "read": ["list_reminder_lists", "list_reminders", "get_reminder"],
  "write": []
  // Write tools, to enable one at a time (milestone 3):
  //   "create_reminder", "complete_reminder", "uncomplete_reminder", "update_reminder"
  // Destructive, leave off unless there is a reason:
  //   "delete_reminder", "batch_delete_reminders", "batch_delete_except"
},

// Home Assistant: SSE on this machine, token from the Keychain.
// These names are from the spec and from HA's Assist API, NOT verified against the running
// server (this build was not allowed to connect to it). Confirm with doctor.
"ha": {
  "transport": "sse",
  "url": "http://127.0.0.1:8123/mcp_server/sse",
  "headers": { "Authorization": "keychain:local-bridge.ha-token" },
  "read": ["GetLiveContext", "GetDateTime", "get_items"],
  "write": []
  // Write tools HA offers (they act on the house):
  //   "HassTurnOn", "HassTurnOff", "HassLightSet", "HassBroadcast", "HassCancelAllTimers",
  //   "HassMediaPause", "HassMediaUnpause", "HassMediaNext", "HassMediaPrevious",
  //   "HassMediaSearchAndPlay", "HassMediaPlayerMute", "HassMediaPlayerUnmute",
  //   "HassSetVolume", "HassSetVolumeRelative",
  //   "HassListAddItem", "HassListCompleteItem", "HassListRemoveItem"
}
```

The other tools of `apple-notes-mcp`, `create_note` and `update_note`, are write tools and
are not listed in the example.

## inspect

What the app runs when a server is being added, to show its tools before any is exposed.

```sh
echo '{"transport":"stdio","command":"/usr/local/bin/node","args":["/path/to/server.js"]}' \
  | node dist/cli.mjs inspect
```

Stdin is one server object, the same shape as an entry under `servers` (`read`, `write`,
`enabled` and `title` may be there and are ignored; `keychain:` values are resolved as `run`
does). The server is started, every tool it offers is listed (all pages), and it is stopped.
Stdout gets exactly one JSON line; the exit code is 0 for `ok: true` and 1 otherwise.

```json
{"ok":true,"tools":[{"name":"search_notes","description":"...","readOnlyHint":true,"suggestedAccess":"read"}]}
{"ok":false,"error":"could not start: ENOENT"}
```

- `description` is always a string, empty when the server gives none. `readOnlyHint` is there
  only when the server's annotations state it.
- `suggestedAccess` is `read` when the annotations say `readOnlyHint: true` or the name starts
  with `get_`, `list_`, `search_`, `read_` or `find_` (any case), and never when they say
  `destructiveHint: true` or `readOnlyHint: false`. Everything else is `write`. It is a default
  for the app's switch, not a decision: nothing is exposed until the config names it.
- Errors are short: `invalid server: ...` (stdin is not JSON or not a server object),
  `could not start: <errno or reason>`, `could not list tools: ...`,
  `timed out starting the server` after 20 s, or the Keychain's "not found" for a missing
  `keychain:` item. Resolved Keychain values are removed from the text.

## Status file

`run` keeps `~/Library/Application Support/local-bridge/status.json` up to date
(`LOCAL_BRIDGE_STATE_DIR` overrides the directory). It is written to a temp file and renamed,
mode 0600, on every change (connection state, a server going up or down or changing its
tools, a call finishing), at most about four times a second, and at least every 15 s. A clean
exit (SIGTERM, SIGINT) removes it. A reader should treat a file older than 45 s, or one whose
`pid` is not running, as "not running".

```json
{"pid":123,"version":"0.2.0","machine":"mini","account":"0123456789abcdef0123","updatedAt":1731700000000,
 "connection":{"state":"connected","since":1731699000000,"lastError":null},
 "servers":[{"name":"notes","title":"Apple Notes","status":"up","error":null,
             "tools":[{"name":"search_notes","access":"read"}]}],
 "calls":{"total":12,"failed":1,"lastAt":1731699990000,"lastTool":"notes.search_notes","lastOutcome":"ok"}}
```

- `connection.state`: `connecting` (first attempt, or a deliberate reconnect), `connected`,
  or `offline` (from a failure until the next successful open, retries included). `since` is
  when the state last changed.
- `connection.lastError` is null once connected. Otherwise: `auth_refused` (the upgrade was
  answered 401 or 403: this Mac's key is not registered for the account), `http_<status>` for
  any other HTTP answer to the upgrade, `close_<code>` for a socket that closed, an error
  class such as `Error ECONNREFUSED`, or `no_account`. Never message text.
- `servers` lists enabled servers only. `title` and `error` are null when there is none;
  `tools` are the exposed tools, empty while the server is down.
- `calls` counts every call answered or refused since start. `failed` counts those answered
  with an error code; `lastOutcome` is `ok` or that code (a tool result that itself says
  `isError` is `ok`, as in the log). `lastTool` is `<server>.<tool>`. The `last*` fields are
  null before the first call. Arguments and results are never written.

When `run` refuses to start for lack of an account, the file is left behind with
`"account":null`, `"servers":[]` and `lastError` `"no_account"`; its `pid` is no longer running.

## Behaviour

- **Servers.** Each is started with the MCP SDK client. A server that fails or exits is
  reported `down` with its tools withheld and restarted with backoff from 1 s to 60 s; the
  others keep working. A stdio server's stderr is discarded (it can quote content); `doctor
  --verbose` shows it.
- **Calls.** At most 4 accepted at once on the machine (running or queued), beyond that
  `busy`. One at a time per server unless `concurrency` says otherwise. Error codes:
  `not_exposed`, `server_down`, `too_large`, `timeout`, `cancelled`, `permission`,
  `tool_error`, `expired`, `busy`.
- **Connection.** `Authorization: Bearer <60 s EdDSA assertion>` on the upgrade; the
  assertion carries the config's `account` as `uid`. `hello` on
  open and whenever a server goes up or down or its tool list changes. `hb` every 60 s.
  Planned reconnect at 110 min after in-flight calls finish (25 s at most). After a drop,
  backoff 1 s to 60 s with jitter. A 5 s timer that sees more than 20 s pass treats it as a
  wake and reconnects at once. A call is answered on the socket it arrived on or not at
  all; nothing is carried across a reconnect.
- **Key rotation.** `rotate-key` stores a pending key under
  `com.martzmakes.local-bridge.device-key.next`. The running agent announces it after its
  next `hello` (or right away on `SIGHUP`), promotes it when the cloud answers
  `{type:"rotated", kid}`, and reconnects with it.
- **Logs.** JSON lines on stdout (the retired LaunchAgent sent them to
  `~/Library/Logs/local-bridge/agent.log`). A call line has the call id, server, tool,
  duration, byte counts and an error class. Arguments, results and error text from local
  servers are never logged and never sent to the cloud. The file is not rotated.

## Keychain

Private key: service `com.martzmakes.local-bridge.device-key`, account = the machine name.
All access is through `/usr/bin/security`: writes use `security -i` with the command on
stdin, reads use `find-generic-password -w`, so no secret is ever in a process's argument
list. Any process running as the same user can read the item the same way; the spec
(section 5.2) is explicit about that.

## LaunchAgent (retired)

The macOS app now starts, restarts and stops the daemon, so the LaunchAgent is retired. Do
not run both: two agents for one machine fight over the connection and the status file. The
scripts are kept for a machine without the app.

`scripts/install.sh` copies the two bundles to `~/Library/Application Support/local-bridge/`,
renders `launchd/com.martzmakes.local-bridge.plist.template` with the absolute path of
`node`, lints it, and bootstraps it into `gui/$UID` (`KeepAlive`, `ThrottleInterval` 10).
Privacy grants attach to that `node` binary. `scripts/render-plist.sh` renders and lints
without installing anything.
