import { cleanScope, resourcePath } from "../../lib/lambdas/oauth/handler";
import { mcpPath } from "../../lib/shared/mcp-path";

const BASE = "https://bridge.martzmakes.com";
const ID = "11d74ff2-cb50-408d-9083-382129fce4c0";
const SERVER = `/mcp/${ID}`;

describe("OAuth resources", () => {
  it("accepts the aggregate endpoint and any per-server endpoint as a resource", () => {
    expect(resourcePath(undefined, BASE)).toBe("/mcp");
    expect(resourcePath(`${BASE}/mcp`, BASE)).toBe("/mcp");
    expect(resourcePath(`${BASE}/mcp/`, BASE)).toBe("/mcp");
    expect(resourcePath(`${BASE}${SERVER}`, BASE)).toBe(SERVER);
  });

  it("refuses resources that are not this server's MCP endpoints", () => {
    expect(resourcePath(`https://elsewhere.example${SERVER}`, BASE)).toBeNull();
    expect(resourcePath(`${BASE}/mcp/mini/notes`, BASE)).toBeNull();
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
  it("parses the aggregate and UUID resources", () => {
    expect(mcpPath("/mcp")).toEqual({ path: "/mcp" });
    expect(mcpPath("/mcp/")).toEqual({ path: "/mcp" });
    expect(mcpPath(`${SERVER}/`)).toEqual({ path: SERVER, endpointId: ID });
  });

  it("rejects named paths, invalid UUIDs and extra path segments", () => {
    expect(mcpPath("/mcp/mini/notes")).toBeNull();
    expect(mcpPath("/mcp/mini")).toBeNull();
    expect(mcpPath("/mcp/00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(mcpPath(`${SERVER}/extra`)).toBeNull();
    expect(mcpPath("/mcpx")).toBeNull();
  });
});
