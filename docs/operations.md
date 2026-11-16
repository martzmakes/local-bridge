# Operations

All commands run from `infra/` with `AWS_PROFILE=your-profile`. `npm run admin -- --help` lists everything.

Day to day, use the macOS app: it adds and removes servers, switches tools on and off, and shows status. The commands here are for what the app does not do: scoped agents, tokens, machine registration and the audit trail.

## The owner

A connector sign-in (magic link) is the built-in agent `owner`. It may use every tool the app has switched on, on every endpoint, with no rules. To change its limits or cut it off, create a row for it:

```bash
npm run admin -- agent create owner --rate-per-minute 60
```

```bash
npm run admin -- agent disable owner
```

## Scoped agents and rules

Any other agent is default deny: it can call nothing, and `bridge_health` is the only tool it sees. Scoped agents use minted tokens, on `/mcp` or on a server's own endpoint.

```bash
npm run admin -- agent create people --description "People channel"
```

Allow one read tool, or every read tool on a server. A wildcard never covers a write tool.

```bash
npm run admin -- allow people mini.notes.search_notes
```

```bash
npm run admin -- allow people 'mini.messages.*'
```

Allow a write tool: exact name and `--write`, and the tool must also be under `write` in that Mac's config.

```bash
npm run admin -- allow people mini.reminders.create_reminder --write
```

Narrow a rule with an argument policy or a result filter (spec section 8.1):

```bash
npm run admin -- allow coach mini.notes.search_notes --rule-json '{"args":{"force":{"folder":"Fitness"}}}'
```

```bash
npm run admin -- allow people mini.messages.search_messages --rule-json '{"result":{"items":{"path":"messages","field":"sender","allow":"^(Mom|Whit)$"}}}'
```

Take access away:

```bash
npm run admin -- deny people mini.notes.search_notes
```

```bash
npm run admin -- agent disable people
```

`agent disable` is immediate for every token. `agent revoke-tokens <agent>` invalidates minted tokens only.

Tool names in rules are the dotted form (`mini.notes.search_notes`). On `/mcp` agents see `mini__notes__search_notes`; on `/mcp/mini/notes` they see `search_notes`.

## Tokens

```bash
npm run mint -- codex --days 90
```

The token goes to stdout and is stored nowhere. Use it as `Authorization: Bearer <token>` against `https://bridge.martzmakes.com/mcp`.

## Machines

```bash
npm run admin -- device list
```

```bash
npm run admin -- device disable mini
```

Rotate a machine's key from the machine: `node agent/dist/cli.mjs rotate-key`. If the key is lost, run `init` again there and `device register` again here.

## Audit

```bash
npm run admin -- audit tail --limit 50
```

Rows hold the agent, the tool, an HMAC of the arguments, sizes, latency and the outcome. No arguments, no results. They expire after 90 days. Days are UTC.

## When something fails

| Symptom | Look at |
|---|---|
| Agent says a machine is offline | `device list`; on the Mac, `launchctl print gui/$(id -u)/com.martzmakes.local-bridge` and `~/Library/Logs/local-bridge/agent.log` |
| Tool missing from an agent's list | The rule (`agent show <agent>`), then the Mac's config `read`/`write` lists, then `device list` for the server's status |
| "Automation permission not granted" / "Full Disk Access not granted" | [`permissions.md`](permissions.md) |
| Everything returns 401 | The token expired or the JWT secret was rotated |
| An endpoint says `mini/notes is not available` | That server is removed or disabled in the app, or the machine has never announced it |
