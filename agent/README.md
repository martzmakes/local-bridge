# local-bridge-agent

The daemon that runs on each Mac. It starts the local MCP servers named in its
config, opens one outbound WebSocket to the bridge, and runs the tool calls the
cloud forwards. Design: `docs/superpowers/specs/2026-11-15-local-bridge-design.md`
(sections 5.2, 6, 10, 11). Wire contract: `infra/lib/shared/protocol.ts`, imported
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

1. Write `~/.config/local-bridge/config.json` (start from `config.example.json`) and `chmod 600` it.
   The agent refuses a config that group or others can read.
2. `node dist/cli.mjs init` generates the Ed25519 device key, stores the private half in the
   login Keychain, and prints the public JWK with the `admin.ts device register` line to run
   from `infra/` on the admin machine.
3. `node dist/cli.mjs doctor` checks the config, the key and each server, lists the exposed
   tools with their class, lists what each server offers that the config does not expose,
   and prints the permissions table.
4. `node dist/cli.mjs run` runs in the foreground. Approve the Automation prompts at the screen.
5. `scripts/install.sh` installs the LaunchAgent (`scripts/uninstall.sh` removes it).

Commands: `init`, `pubkey`, `rotate-key`, `doctor`, `run`. All take `--config <path>`;
`LOCAL_BRIDGE_CONFIG` overrides the default path. `init` and `pubkey` take
`--machine <name>` for use before a config exists.

## Config

A tool reaches the cloud only if it is named under `read` or `write`. A name in both lists
is `write`. Anything the server offers that is not named stays invisible, including tools
that appear after a server upgrade. Unknown keys are rejected, so a typo such as `"reads"`
is an error instead of an empty allowlist.

| Field | Meaning |
|---|---|
| `machine` | `[a-z0-9]{1,16}`; must match the name registered in the cloud |
| `endpoint` | `wss://` URL (`ws://` only for localhost) |
| `servers.<name>` | `[a-z0-9]{1,16}`; this name, not the server's own, appears in tool ids |
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

## Behaviour

- **Servers.** Each is started with the MCP SDK client. A server that fails or exits is
  reported `down` with its tools withheld and restarted with backoff from 1 s to 60 s; the
  others keep working. A stdio server's stderr is discarded (it can quote content); `doctor
  --verbose` shows it.
- **Calls.** At most 4 accepted at once on the machine (running or queued), beyond that
  `busy`. One at a time per server unless `concurrency` says otherwise. Error codes:
  `not_exposed`, `server_down`, `too_large`, `timeout`, `cancelled`, `permission`,
  `tool_error`, `expired`, `busy`.
- **Connection.** `Authorization: Bearer <60 s EdDSA assertion>` on the upgrade. `hello` on
  open and whenever a server goes up or down or its tool list changes. `hb` every 60 s.
  Planned reconnect at 110 min after in-flight calls finish (25 s at most). After a drop,
  backoff 1 s to 60 s with jitter. A 5 s timer that sees more than 20 s pass treats it as a
  wake and reconnects at once. A call is answered on the socket it arrived on or not at
  all; nothing is carried across a reconnect.
- **Key rotation.** `rotate-key` stores a pending key under
  `com.martzmakes.local-bridge.device-key.next`. The running agent announces it after its
  next `hello` (or right away on `SIGHUP`), promotes it when the cloud answers
  `{type:"rotated", kid}`, and reconnects with it.
- **Logs.** JSON lines on stdout, which the LaunchAgent sends to
  `~/Library/Logs/local-bridge/agent.log`. A call line has the call id, server, tool,
  duration, byte counts and an error class. Arguments, results and error text from local
  servers are never logged and never sent to the cloud. The file is not rotated.

## Keychain

Private key: service `com.martzmakes.local-bridge.device-key`, account = the machine name.
All access is through `/usr/bin/security`: writes use `security -i` with the command on
stdin, reads use `find-generic-password -w`, so no secret is ever in a process's argument
list. Any process running as the same user can read the item the same way; the spec
(section 5.2) is explicit about that.

## LaunchAgent

`scripts/install.sh` copies the two bundles to `~/Library/Application Support/local-bridge/`,
renders `launchd/com.martzmakes.local-bridge.plist.template` with the absolute path of
`node`, lints it, and bootstraps it into `gui/$UID` (`KeepAlive`, `ThrottleInterval` 10).
Privacy grants attach to that `node` binary. `scripts/render-plist.sh` renders and lints
without installing anything.
