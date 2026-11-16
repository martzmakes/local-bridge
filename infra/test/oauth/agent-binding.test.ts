import { agentFromResource, agentFromScope, scopeWithAgent } from "../../lib/lambdas/oauth/handler";
import { agentFromPath } from "../../lib/lambdas/mcp/server";

const BASE = "https://bridge.martzmakes.com";

describe("OAuth agent binding", () => {
  it("maps the MCP URL a client signs in to onto a bridge agent", () => {
    expect(agentFromResource(undefined, BASE)).toBe("connector");
    expect(agentFromResource(`${BASE}/mcp`, BASE)).toBe("connector");
    expect(agentFromResource(`${BASE}/mcp/`, BASE)).toBe("connector");
    expect(agentFromResource(`${BASE}/mcp/a/people`, BASE)).toBe("people");
  });

  it("refuses resources that are not this server's MCP URLs", () => {
    expect(agentFromResource("https://evil.example/mcp/a/people", BASE)).toBeNull();
    expect(agentFromResource(`${BASE}/mcp/a/People`, BASE)).toBeNull();
    expect(agentFromResource(`${BASE}/mcp/a/people/extra`, BASE)).toBeNull();
    expect(agentFromResource(`${BASE}/other`, BASE)).toBeNull();
  });

  it("does not let a client choose its agent through the scope parameter", () => {
    const scope = scopeWithAgent("mcp:tools agent:people agent:admin", "coach");
    expect(scope).toBe("mcp:tools agent:coach");
    expect(agentFromScope(scope)).toBe("coach");
  });

  it("falls back to the default agent for scopes without a binding", () => {
    expect(agentFromScope("mcp:read mcp:tools")).toBe("connector");
  });

  it("resolves the same agent from the request path", () => {
    expect(agentFromPath("/mcp")).toBe("connector");
    expect(agentFromPath("/mcp/a/people")).toBe("people");
    expect(agentFromPath("/mcp/a/")).toBeNull();
    expect(agentFromPath("/mcp/ui/x")).toBeNull();
  });
});
