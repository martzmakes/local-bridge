// Default env for unit tests. Lambda modules read these at import time; set them
// before any test module loads so static imports work without dynamic import().
process.env.USERS_TABLE = process.env.USERS_TABLE || "test-users";
process.env.BRIDGE_TABLE = process.env.BRIDGE_TABLE || "test-bridge";
process.env.AUDIT_HMAC_PARAM = process.env.AUDIT_HMAC_PARAM || "/local-bridge/audit-hmac-key";
process.env.WS_MANAGEMENT_ENDPOINT = process.env.WS_MANAGEMENT_ENDPOINT || "https://example.execute-api.us-east-1.amazonaws.com/prod";
process.env.PROJECT_SLUG = process.env.PROJECT_SLUG || "local-bridge";
process.env.DOMAIN = process.env.DOMAIN || "bridge.martzmakes.com";
process.env.JWT_SECRET_NAME = process.env.JWT_SECRET_NAME || "/local-bridge/jwt-secret";
