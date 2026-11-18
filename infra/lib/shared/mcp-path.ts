/** The canonical lowercase UUIDv4 generated for a server's connector. */
export const ENDPOINT_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Parses a resource path without revealing whether the endpoint exists. */
export function mcpPath(rawPath: string): { path: string; endpointId?: string } | null {
  const path = rawPath.replace(/\/+$/, "");
  if (path === "/mcp") return { path };
  const endpointId = path.slice("/mcp/".length);
  return path.startsWith("/mcp/") && endpointId.length === 36 && ENDPOINT_ID_RE.test(endpointId) ? { path, endpointId } : null;
}
