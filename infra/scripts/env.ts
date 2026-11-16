// Environment for the admin scripts. Import this FIRST: the Lambda modules read
// process.env at import time. Run with AWS_PROFILE=your-profile.
import { readFileSync } from "fs";
import { join } from "path";

process.env.AWS_REGION ||= "us-east-1";
process.env.PROJECT_SLUG ||= "local-bridge";
process.env.DOMAIN ||= "bridge.martzmakes.com";
process.env.JWT_SECRET_NAME ||= "/local-bridge/jwt-secret";
process.env.ALLOWED_EMAILS ||= "operator@example.com";

if (!process.env.BRIDGE_TABLE) {
  try {
    const outputs = JSON.parse(readFileSync(join(__dirname, "..", "cdk-outputs.json"), "utf8"));
    process.env.BRIDGE_TABLE = outputs.LocalBridgeStack.BridgeTableName;
  } catch {
    // Left unset; commands that need the table fail with a clear message.
  }
}

export const OWNER_EMAIL = process.env.ALLOWED_EMAILS.split(",")[0].trim();

/** `--user <email>` from argv, else the owner. The account every admin command acts on. */
export function userEmail(argv: string[] = process.argv): string {
  const i = argv.indexOf("--user");
  const email = i >= 0 ? argv[i + 1] : OWNER_EMAIL;
  if (!email || !email.includes("@")) throw new Error("--user needs an email address");
  return email.trim().toLowerCase();
}

export function requireTable(): string {
  const t = process.env.BRIDGE_TABLE;
  if (!t) throw new Error("BRIDGE_TABLE is not set and infra/cdk-outputs.json was not found. Deploy first, or export BRIDGE_TABLE.");
  return t;
}
