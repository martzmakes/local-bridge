// Mints a machine token for one bridge agent.
//   AWS_PROFILE=your-profile npx ts-node --prefer-ts-exts scripts/mint.ts <agent> [--days 90]
// The token is printed to stdout and stored nowhere. It is valid until it
// expires or until `admin.ts agent revoke-tokens <agent>` bumps the version.
import { userEmail } from "./env";
import { mintJwt } from "../lib/lambdas/auth/lib/jwt";
import { isValidAgentId } from "../lib/lambdas/bridge/names";
import { getStore } from "../lib/lambdas/bridge/runtime";
import { uidFromEmail } from "../lib/lambdas/bridge/tenant";
import { requireTable } from "./env";

async function main() {
  const [agent, ...rest] = process.argv.slice(2);
  if (!agent || !isValidAgentId(agent)) throw new Error("usage: mint.ts <agent> [--days N] [--user email]");
  const email = userEmail();
  const i = rest.indexOf("--days");
  const days = i >= 0 ? Number(rest[i + 1]) : 90;
  if (!Number.isFinite(days) || days <= 0 || days > 366) throw new Error("--days must be between 1 and 366");
  requireTable();
  const found = await getStore().forTenant(uidFromEmail(email)).getAgent(agent);
  if (!found) throw new Error(`agent "${agent}" does not exist. Create it with: admin.ts agent create ${agent}`);
  if (!found.meta.enabled) throw new Error(`agent "${agent}" is disabled`);
  const token = await mintJwt(email, {
    agent,
    tv: found.meta.tokenVersion,
    kind: "minted",
    ttlSeconds: Math.round(days * 86_400),
  });
  process.stderr.write(`user=${email} agent=${agent} tokenVersion=${found.meta.tokenVersion} expires in ${days} days\n`);
  process.stdout.write(token + "\n");
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
