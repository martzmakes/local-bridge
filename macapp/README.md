# Local Bridge for Mac

The macOS app for Local Bridge. You sign in, add the MCP servers that run on this Mac, and each
one gets its own address (`https://bridge.martzmakes.com/mcp/<uuid>`). The app runs
the Node agent from `../agent` as its own child process, so macOS attaches Automation, Reminders
and Full Disk Access to the signed app instead of to `node`.

Design: `../docs/superpowers/specs/2026-11-15-mac-app-per-server-endpoints-design.md`
(sections 4 to 7 and 9).

## Build and run

Needs Xcode 16 or later (Swift 6) and a system `node`. No Xcode project; SwiftPM only.

```sh
cd macapp
swift build                 # debug build of the library and the app
swift test                  # LocalBridgeCore tests; offline, no Keychain, no network
(cd ../agent && npm run build)   # the app bundles agent/dist/cli.mjs and agent.mjs
./scripts/build-app.sh      # build/Local Bridge.app, signed with Developer ID, hardened runtime
open "build/Local Bridge.app"
```

`build-app.sh` signs with `Developer ID Application: Matt Martz (EXAMPLETEAM)`. If the timestamp
server cannot be reached it signs with `--timestamp=none`; if the certificate is not in the
keychain it signs ad hoc and says so. Neither fallback happens in release mode.

### Updates and releases

Install the first Sparkle-enabled build in `/Applications`. Use **Check for Updates…** from the Local Bridge menu or menu bar item. **Settings → General → Software Updates** controls automatic checks. Updates are verified before extraction, and Sparkle also verifies the signed feed.

```sh
./scripts/release.sh 0.3.0         # build, notarize, staple, and prepare the signed feed
./scripts/publish-update.sh 0.3.0  # publish the archive, then replace the live appcast
```

Run these from `macapp` after rebuilding the daemon. Releases are stored under `build/release/<version>`. Each release needs a higher `CFBundleVersion`. The timestamp is the default and `--build <n>` overrides it. The live distribution uses immutable versioned ZIPs under `/updates/` and serves the appcast without caching it.

The release script uses the App Store Connect API key if available and otherwise uses the `local-bridge-notary` Keychain profile. Override the notary settings with `LOCALBRIDGE_ASC_KEY_ID`, `LOCALBRIDGE_ASC_KEY_FILE`, `LOCALBRIDGE_ASC_ISSUER`, or `LOCALBRIDGE_NOTARY_PROFILE`. Set `LOCALBRIDGE_RELEASE_ROOT` for a different release directory.

The Sparkle private key is in the login Keychain under account `local-bridge`. Self-hosted builds can set `LOCALBRIDGE_UPDATE_FEED_URL` and `LOCALBRIDGE_SPARKLE_PUBLIC_KEY` to their own HTTPS feed and public key. Use `LOCALBRIDGE_SPARKLE_KEY_ACCOUNT` to select that key when preparing and publishing an update.

### Snapshots

```sh
./scripts/snapshots.sh            # build/snapshots/<screen>-light.png and -dark.png
```

Renders every screen to PNG without showing a window, so the UI can be reviewed with the screen
locked. It is a launch mode of the app binary (`LOCAL_BRIDGE_SNAPSHOT_DIR=<dir>`): the real views
with fixed sample state (`Sources/LocalBridge/Snapshot/`), no daemon, Keychain, network or real
config. Windows are never put on screen, so controls are drawn in their inactive (grey) state.
`LOCAL_BRIDGE_SNAPSHOT_LIVE=1 ./scripts/snapshots.sh` instead shows each main-window screen and
sheet on screen and captures it with `screencapture` (real vibrancy, real sheets, 1x or 2x as the
display is). Started from a background shell the process is not allowed to become the active app,
so controls still look inactive; the output line says `not key` when that happens.

### Running against scratch files

Every path can be moved, so a manual run never touches the real config:

| Variable | Replaces |
|---|---|
| `LOCAL_BRIDGE_CONFIG` | `~/.config/local-bridge/config.json` |
| `LOCAL_BRIDGE_STATE_DIR` | `~/Library/Application Support/local-bridge/` (`status.json`, the app's tool cache) |
| `LOCAL_BRIDGE_AGENT_DIR` | `Contents/Resources/agent/` in the bundle (the directory holding `cli.mjs`) |
| `LOCAL_BRIDGE_NO_ACCOUNT=1` | Development only: skip sign-in and do not touch the Keychain. The cloud still refuses a Mac without an account, so this is for looking at the UI or a local test endpoint. |

```sh
LOCAL_BRIDGE_NO_ACCOUNT=1 LOCAL_BRIDGE_CONFIG=/tmp/lb/config.json LOCAL_BRIDGE_STATE_DIR=/tmp/lb/state \
  "build/Local Bridge.app/Contents/MacOS/LocalBridge"
```

The node path and the paused state are app preferences (`defaults read com.martzmakes.localbridge`),
not part of the config file, and are not moved by these variables.

## Where things live

| | |
|---|---|
| `Sources/LocalBridgeCore/` | Everything without UI. `BridgeConfig` (the daemon's config, unknown keys preserved, sorted pretty output), `ConfigValidator` (the daemon's rules), `ConfigStore` (atomic 0600 save), `StatusReader` (`status.json`), `InspectRunner` (`cli.mjs inspect`), `DaemonSupervisor` (the child process), `NodeLocator`, `ActivityBuffer` (the daemon's log lines), `AccountClient` (OAuth with PKCE, account API), `KeychainTokenStore`, `PermissionCatalog`. |
| `Sources/LocalBridge/` | The SwiftUI app. `AppModel` holds all state; `Views/` are the sign-in screen, the server list and detail, the add sheet, Activity, Settings (General, Account, Permissions) and the menu bar item. |
| `Tests/LocalBridgeCoreTests/` | XCTest. Process tests run small shell scripts in place of node; account tests use a fake HTTP transport and an in-memory token store. |
| `Resources/` | `Info.plist`, entitlements (hardened runtime, Apple Events; not sandboxed), `AppIcon.icns` (drawn by `scripts/make-icon.swift`). |
| `scripts/` | `build-app.sh`, `release.sh`, `publish-update.sh`, `make-icon.swift`. |

At run time:

- Config: `~/.config/local-bridge/config.json`. The app is its only writer. A file the daemon
  would refuse is shown read-only with the error and is never overwritten.
- Account tokens: one Keychain generic password, service `com.martzmakes.localbridge.account`,
  account = the public base URL. The OAuth client id is in the app's preferences.
- Device key: the agent's own Keychain item, created by `cli.mjs init` the first time this Mac
  registers. Signing out keeps it.
- Daemon status: `~/Library/Application Support/local-bridge/status.json`, written by the agent.

## How it behaves

- Signed out: one sign-in screen, no daemon. Signing in opens the browser; the callback comes
  back on `localbridge://oauth/callback`.
- After sign-in the app runs `cli.mjs init` and `pubkey`, registers this Mac with
  `PUT /api/machines/<machine>`, writes `"account"` into the config and starts the daemon. If the
  daemon later reports `auth_refused` or `no_account`, the app registers again by itself, at most
  once a minute.
- Add Server opens on what other apps on this Mac already have (Claude Code, Claude Desktop,
  Cursor, Windsurf, VS Code, Codex). Those files are only read, and only when that sheet is
  opened. Env and header values are carried into the config when a server is imported and are
  never shown.
- Each tool has a Try… button that runs it once on this Mac through `cli.mjs call`. The result is
  shown in the sheet and kept nowhere.
- Activity is kept across launches in `<state dir>/activity.jsonl` (the last 500 calls; times,
  names, outcomes and durations only).
- Save validates, writes, and restarts the daemon. The daemon is restarted with backoff
  (1 s doubling to 60 s) when it exits, stopped with SIGTERM then SIGKILL after 5 s, and stopped
  when the app quits (also on SIGTERM and SIGINT).
- The daemon is not started while the v1 LaunchAgent `com.martzmakes.local-bridge` is loaded, when
  node is missing, when the config file is invalid, or when another bridge agent is already
  running (the app says which and offers the way out).
- A write tool is off until switched on, and switching it on asks once per tool per app run.

## Not done

- Storing header and environment values in the Keychain from the app. There is no control for it.
  Values are saved in the config file (0600). A value typed as `keychain:<service>` is shown as
  a reference with a key icon and works, because the agent resolves it. Values that look secret
  are shown in a secure field once saved.
- If the app is killed with SIGKILL or crashes, the daemon child keeps running. The next launch
  notices it and offers to stop it; it is not reaped automatically.
- The daemon's own output is not written to a log file by the app.
- A server's name cannot be changed after it is added (it is the address). Remove and add again.
- `concurrency`, `callTimeoutMs` and `cwd` have no controls. They are preserved when present.
- No bundled Node, no auto-update, no DMG.
- The UI has not been through a design review on screen, and the sign-in flow has only been
  exercised against a fake transport in tests, not against the deployed bridge.
