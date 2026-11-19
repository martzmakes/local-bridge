# MCP server + widgets

The template ships an opt-out **MCP server** that exposes your app's data and actions to AI assistants like **Claude Desktop**, **ChatGPT** (via remote connectors), and **Goose**. Tools you define here become callable from a chat interface; widgets you define render inline as iframed UI alongside tool results.

> [!note] Don't need MCP?
> Delete `infra/lib/lambdas/mcp/`, `infra/lib/lambdas/oauth/`, the **MCP + OAuth block** in `infra-stack.ts` (clearly demarcated), `OAuthTable`, `app/src/hooks/useMcp.ts`, and the `qrcode` deps from `infra/package.json`. Removing the block costs ~300 lines and one DDB table.

## What MCP is

[MCP (Model Context Protocol)](https://modelcontextprotocol.io) is the open spec Anthropic, OpenAI, and others use to let AI clients call tools and read resources from third-party servers. From the user's perspective: in Claude Desktop they add `https://your-domain.com/mcp` as a connector, sign in via your magic link once, and from then on Claude can invoke your tools by name during conversation.

## What this template gives you

| Endpoint | Purpose |
|---|---|
| `POST /mcp` | JSON-RPC 2.0 server (Streamable HTTP transport). Bearer-JWT authenticated. |
| `GET /mcp/ui/<name>` | Public widget HTML (iframed by Claude alongside tool results). |
| `GET /.well-known/oauth-protected-resource` | RFC 9728 discovery. |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 discovery. |
| `POST /oauth/register` | RFC 7591 dynamic client registration. |
| `GET /oauth/authorize` | Sign-in page (with QR for hand-off to mobile). |
| `POST /oauth/email` | Form post — sends the magic-link to the user. |
| `POST /oauth/token` | RFC 7636 PKCE token exchange. |

The OAuth flow uses your existing magic-link sign-in for approval — users never copy a bearer token by hand. After one successful sign-in, an SSO cookie auto-approves future authorizations from the same browser.

## Files

```
infra/lib/lambdas/mcp/
  server.ts        JSON-RPC dispatch, tool catalog, widget HTML serving
  widgets.ts       Widget HTML + the postMessage bootstrap shared by all widgets

infra/lib/lambdas/oauth/
  handler.ts       Discovery + register + authorize + email + token endpoints

infra/lib/lambdas/auth/verify.ts
                   Existing magic-link verifier — extended to handle the OAuth
                   handoff branch and set the SSO cookie.

app/src/hooks/useMcp.ts
                   Helper for calling your own MCP tools from inside the app.

scripts/mcp-sandbox-domain.sh
                   Computes the Claude widget sandbox domain after first deploy.
```

## Adding a tool

1. Append to the `TOOLS` array in `infra/lib/lambdas/mcp/server.ts`:

   ```ts
   {
     name: "create_thing",
     description:
       "Creates a thing for the signed-in user. Returns the new thing's id.",
     inputSchema: {
       type: "object",
       required: ["title"],
       properties: {
         title: { type: "string", description: "Human-readable title" },
       },
     },
   }
   ```

2. Implement the handler:

   ```ts
   async function createThing(email: string, args: Record<string, unknown>) {
     // Validate args. Write to DynamoDB. Return structured result.
     return { id: randomUUID(), title: args.title };
   }
   ```

3. Wire it in `callTool()`:

   ```ts
   case "create_thing":
     return await createThing(email, args);
   ```

4. Redeploy. Tools that change schema show up immediately on the next `tools/list` call from the client (no restart in Claude Desktop).

### Tool description tips

The description is the **prompt** Claude reads to decide when to invoke your tool. Be specific:

- ✅ "Logs a meal for the current user. REQUIRED: mealSlot — every food belongs to one of breakfast / lunch / dinner / snack so the dashboard can group it. If the user doesn't specify, ask or infer from context."
- ❌ "Logs a meal."

Spell out required fields, what to do when ambiguous, and what the tool returns. Treat it like instructions for a junior dev.

## Adding a widget

Widgets are HTML documents Claude iframes inline with tool results. They receive the `structuredContent` from the paired tool call via a postMessage handshake.

1. Add an HTML literal to `infra/lib/lambdas/mcp/widgets.ts`:

   ```ts
   const THING_LIST_HTML = `<!doctype html>
   <html>...
   <script>
   function render(output) {
     // output is the structuredContent from your tool
     document.getElementById('list').innerHTML = output.things
       .map(t => `<li>${t.title}</li>`).join('');
   }
   ${WIDGET_BOOTSTRAP_JS}
   </script>
   </html>`;
   ```

   The `${WIDGET_BOOTSTRAP_JS}` interpolation gives you the JSON-RPC handshake, `tool-result` listener, height notifications, and `window.openai` shim for free. You only write `render(output)`.

2. Register it in `UI_RESOURCES`:

   ```ts
   [`ui://${PROJECT_SLUG}/thing-list`]: {
     uri: `ui://${PROJECT_SLUG}/thing-list`,
     name: "thing-list",
     description: "List of things owned by the signed-in user.",
     mimeType: "text/html;profile=mcp-app",
     content: THING_LIST_HTML,
     meta: DEFAULT_META,
   },
   ```

3. Pair it with a tool by adding `_meta` in `server.ts`:

   ```ts
   {
     name: "list_things",
     description: "...",
     inputSchema: { ... },
     _meta: widgetUiMeta(`ui://${PROJECT_SLUG}/thing-list`),
   }
   ```

4. Redeploy. When Claude calls `list_things`, it'll iframe `https://<your-domain>/mcp/ui/thing-list` and forward the structuredContent via postMessage.

### Widget styling

The shipped widget (`user-card`) uses the martzmakes design palette (`#07090C` bg, `#3B82FF` accent, General Sans + JetBrains Mono). Match it for consistency, or override per widget. Widgets render inside Claude's chat, so they should:

- Use `background: transparent` so the chat scrim shows through, OR
- Use the same dark palette as the rest of your UI.

Width is constrained by the chat column (~520px on desktop). Test at narrow widths.

## After your first deploy: pin the sandbox domain

Claude derives the widget iframe's sandbox host as `sha256(mcpUrl).slice(0,32) + ".claudemcpcontent.com"`. Until you pin this value, widgets work but Claude shows a "local connector" warning.

Compute it after your first deploy:

```bash
scripts/mcp-sandbox-domain.sh https://your-domain.com/mcp
# → c3d80a4ed901ee05b21755a88273b4a4.claudemcpcontent.com
```

Then either:

- Add `MCP_WIDGET_DOMAIN: "<value>.claudemcpcontent.com"` to the `mcpHandler` env in `infra-stack.ts` (recommended), or
- Hardcode the value in both `server.ts` and `widgets.ts`.

Redeploy. Claude will accept the widget domain and stop showing the warning.

## Connecting from Claude Desktop

1. Open Claude Desktop → **Settings** → **Connectors** → **Add custom connector**.
2. Paste `https://your-domain.com/mcp`.
3. Claude fetches `/.well-known/oauth-protected-resource`, finds the OAuth server, runs the PKCE flow.
4. Sign-in page appears in your browser — enter your email.
5. Magic link arrives — tap it; Claude session is approved automatically.
6. New tools show up in Claude with your project name.

## Connecting from your own app

`app/src/hooks/useMcp.ts` provides the same JSON-RPC over HTTP helper Claude uses, but bound to the user's existing JWT (no OAuth dance — they're already signed in):

```tsx
import { callTool } from "../hooks/useMcp";

const result = await callTool<MyResult>(jwt, "list_things", { limit: 10 });
```

Useful for in-app dashboards that share logic with the MCP-exposed tools.

## CloudFront proxy — why MCP needs the custom domain

The CDK stack adds CloudFront behaviors that proxy `/mcp`, `/mcp/*`, `/oauth/*`, `/.well-known/*`, `/auth/*`, and `/api/*` to API Gateway. Without this, Claude rejects widget `ui.domain` hints from raw `*.execute-api.amazonaws.com` URLs ("local connector" error).

The custom-domain proxy is **not optional for MCP** — the OAuth metadata's `issuer` and the widget sandbox domain hash both depend on the public URL Claude sees being a real domain.

## Costs

The MCP server is just two more Lambdas + one DDB table (`OAuthTable`). At low scale (single-user dev, occasional tool calls) costs are pennies/month. The biggest cost driver is widget HTML byte size — each tool call returns a fresh HTML payload to Claude. Keep widgets compact (<50KB) and avoid bundling fonts/images inline.

## Testing

```bash
# Quick check the MCP server is reachable
curl -X POST https://your-domain.com/mcp \
  -H 'authorization: Bearer <your-jwt>' \
  -H 'content-type: application/json' \
  -d '{"jsonrpc":"2.0","id":1,"method":"tools/list"}'

# Discovery (no auth required)
curl https://your-domain.com/.well-known/oauth-protected-resource
curl https://your-domain.com/.well-known/oauth-authorization-server

# Widget HTML (no auth required — public assets)
curl https://your-domain.com/mcp/ui/user-card
```

For full Claude Desktop testing you need the connector setup; the OAuth flow can't be unit-tested without a client.

## Spec references

- [Model Context Protocol](https://modelcontextprotocol.io)
- [MCP Streamable HTTP transport](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
- [MCP Apps extension (widgets)](https://modelcontextprotocol.io/specification/draft/server/tools)
- RFCs: [9728](https://datatracker.ietf.org/doc/html/rfc9728) (protected-resource metadata), [8414](https://datatracker.ietf.org/doc/html/rfc8414) (auth server metadata), [7591](https://datatracker.ietf.org/doc/html/rfc7591) (dynamic registration), [7636](https://datatracker.ietf.org/doc/html/rfc7636) (PKCE)
