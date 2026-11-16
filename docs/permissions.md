# macOS permissions for the local servers

The agent runs as a per-user LaunchAgent, so macOS attributes what its child processes do to the binary launchd started: the `node` named in the plist. The grants below go to that `node` binary (System Settings, Privacy & Security). That is broader than it should be, since every script that binary runs inherits them; the fix is the signed wrapper app in the spec's hardening list.

Grant only what the servers you actually expose need.

| Server | Permission | Where | Why |
|---|---|---|---|
| `apple-notes-mcp` | Automation: control **Notes** | Privacy & Security, Automation | Reads and writes notes with AppleScript through `osascript`. No disk access. |
| `imessage-mcp` | **Full Disk Access** | Privacy & Security, Full Disk Access | Reads `~/Library/Messages/chat.db` and the AddressBook databases under `~/Library/Application Support/AddressBook`. Both are protected locations no narrower permission covers. |
| `imessage-mcp` | Automation: control **Contacts** | Automation | Falls back to AppleScript for contact names. |
| `imessage-mcp` (only if sending is ever enabled) | Automation: control **Messages** | Automation | Sending goes through AppleScript. |
| `apple-reminders-mcp` | **Reminders** (full access) | Privacy & Security, Reminders | Its Swift helper uses EventKit. A missing grant exits 0 and looks like "no reminders", so check with `doctor`. |
| Home Assistant | none | | Plain HTTP to `127.0.0.1:8123` with a token from the Keychain. If HA moves to another host on the LAN, macOS asks for **Local Network** access. |
| the agent | Keychain item access | automatic | Reads its device key and any `keychain:` config values with `/usr/bin/security`. |

Notes:

- Automation prompts ("node wants to control Notes") appear the first time a tool drives that app, and only in a logged-in GUI session. Approve them at the Mac's screen or over Screen Sharing. Until then the call fails and the agent reports "Automation permission not granted for Notes".
- Full Disk Access has no prompt. Add the node binary by hand: run `which node` (and `readlink -f` it, Homebrew's is a symlink) and drag that file into the list. A Homebrew upgrade that changes the path means doing it again.
- Full Disk Access to `node` lets any Node script running as you read your Messages database. If that is not acceptable, leave the Messages server out until the signed wrapper exists.
- The Mac has to be awake and logged in. A sleeping Mac is offline to the bridge, and calls fail fast saying so.
