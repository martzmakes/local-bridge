import { cleanScope, resourcePath } from "../../lib/lambdas/oauth/handler";
import { scopeFromPath } from "../../lib/lambdas/mcp/server";

const BASE = "https://bridge.martzmakes.com";

describe("OAuth resources", () => {
  it("accepts the aggregate endpoint and any per-server endpoint as a resource", () => {
    expect(resourcePath(undefined, BASE)).toBe("/mcp");
    expect(resourcePath(`${BASE}/mcp`, BASE)).toBe("/mcp");
    expect(resourcePath(`${BASE}/mcp/`, BASE)).toBe("/mcp");
    expect(resourcePath(`${BASE}/mcp/mini/notes`, BASE)).toBe("/mcp/mini/notes");
  });

  it("refuses resources that are not this server's MCP endpoints", () => {
    expect(resourcePath("https://evil.example/mcp/mini/notes", BASE)).toBeNull();
    expect(resourcePath(`${BASE}.evil.example/mcp`, BASE)).toBeNull();
    expect(resourcePath(`${BASE}/mcp/mini`, BASE)).toBeNull();
    expect(resourcePath(`${BASE}/mcp/mini/notes/extra`, BASE)).toBeNull();
    expect(resourcePath(`${BASE}/mcp/Mini/notes`, BASE)).toBeNull();
    expect(resourcePath(`${BASE}/oauth/token`, BASE)).toBeNull();
  });

  it("does not let a client choose an agent through the scope parameter", () => {
    expect(cleanScope("mcp:tools agent:people agent:admin")).toBe("mcp:tools");
    expect(cleanScope("agent:admin")).toBe("mcp:read mcp:tools");
    expect(cleanScope(undefined)).toBe("mcp:read mcp:tools");
  });
});

describe("request paths", () => {
  it("maps /mcp to the aggregate endpoint and /mcp/<machine>/<server> to one server", () => {
    expect(scopeFromPath("/mcp")).toEqual({});
    expect(scopeFromPath("/mcp/")).toEqual({});
    expect(scopeFromPath("/mcp/mini/notes")).toEqual({ scope: { machine: "mini", server: "notes" } });
  });

  it("rejects anything else, including the retired per-agent paths", () => {
    expect(scopeFromPath("/mcp/mini")).toBeNull();
    expect(scopeFromPath("/mcp/mini/notes/x")).toBeNull();
    expect(scopeFromPath("/mcp/mini/No_tes")).toBeNull();
    expect(scopeFromPath("/mcpx")).toBeNull();
  });
});
