// Admin CLI for Local Bridge: agents, allowlist rules, machines, audit.
//   AWS_PROFILE=your-profile npx ts-node --prefer-ts-exts scripts/admin.ts <command>
import { requireTable } from "./env";
import { readFileSync } from "fs";
import { createHash } from "crypto";
import { OFFLINE_AFTER_MS } from "../lib/shared/protocol";
import { isValidAgentId, isValidName, parseCanonical } from "../lib/lambdas/bridge/names";
import { RuleSchema, type Rule } from "../lib/lambdas/bridge/policy";
import { getStore } from "../lib/lambdas/bridge/runtime";
import { AGENT_DEFAULTS, type AgentMeta, type DeviceKey } from "../lib/lambdas/bridge/store";

const HELP = `Local Bridge admin

Agents
  agent list
  agent show <agent>
  agent create <agent> [--description "..."] [--rate-per-minute N] [--rate-per-day N]
                       [--max-result-bytes N] [--call-timeout-ms N]
  agent set <agent> [same options as create]
  agent enable <agent> | agent disable <agent>
  agent revoke-tokens <agent>          invalidate every minted token for the agent

Rules (default deny; a write tool needs --write and an exact tool name)
  allow <agent> <machine.server.tool | machine.server.*> [--write]
        [--rule-json '<json>' | --rule-file path]   args/result policy, see the spec section 8.1
  deny <agent> <tool>                  remove a rule

Machines
  device list
  device register <machine> '<public jwk json>'    replaces all keys for the machine
  device enable <machine> | device disable <machine>

Audit
  audit tail [--day YYYY-MM-DD] [--limit N]
`;

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}
function has(args: string[], name: string): boolean {
  return args.includes(name);
}
function num(args: string[], name: string): number | undefined {
  const v = flag(args, name);
  if (v === undefined) return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`${name} must be a positive number`);
  return n;
}
function need(value: string | undefined, what: string): string {
  if (!value) throw new Error(`missing ${what}\n\n${HELP}`);
  return value;
}
function agentId(value: string | undefined): string {
  const id = need(value, "<agent>");
  if (!isValidAgentId(id)) throw new Error(`invalid agent id "${id}" (lowercase letters, digits, hyphens; up to 32)`);
  return id;
}

function limitsFrom(args: string[]): Partial<AgentMeta> {
  const out: Partial<AgentMeta> = {};
  const d = flag(args, "--description");
  if (d !== undefined) out.description = d;
  const m = { ratePerMinute: "--rate-per-minute", ratePerDay: "--rate-per-day", maxResultBytes: "--max-result-bytes", callTimeoutMs: "--call-timeout-ms", maxArgBytes: "--max-arg-bytes" } as const;
  for (const [k, f] of Object.entries(m)) {
    const v = num(args, f);
    if (v !== undefined) (out as Record<string, number>)[k] = v;
  }
  return out;
}

async function main() {
  const [group, ...args] = process.argv.slice(2);
  if (!group || group === "--help" || group === "help") {
    process.stdout.write(HELP);
    return;
  }
  requireTable();
  const store = getStore();

  if (group === "agent") {
    const [cmd, idArg] = args;
    if (cmd === "list") {
      for (const a of await store.listAgents()) {
        console.log(`${a.id.padEnd(20)} ${a.enabled ? "enabled " : "DISABLED"} tv=${a.tokenVersion} ${a.ratePerMinute}/min ${a.ratePerDay}/day  ${a.description ?? ""}`);
      }
      return;
    }
    const id = agentId(idArg);
    const existing = await store.getAgent(id);
    if (cmd === "create") {
      if (existing) throw new Error(`agent "${id}" already exists`);
      await store.putAgent({ ...AGENT_DEFAULTS, id, createdAt: Date.now(), ...limitsFrom(args) });
      console.log(`created agent ${id} with no rules (it can call nothing yet)`);
      return;
    }
    if (!existing) throw new Error(`agent "${id}" does not exist`);
    if (cmd === "show") {
      console.log(JSON.stringify(existing, null, 2));
    } else if (cmd === "set") {
      await store.putAgent({ ...existing.meta, ...limitsFrom(args) });
      console.log(`updated ${id}`);
    } else if (cmd === "enable" || cmd === "disable") {
      await store.putAgent({ ...existing.meta, enabled: cmd === "enable" });
      console.log(`${id} ${cmd}d`);
    } else if (cmd === "revoke-tokens") {
      await store.putAgent({ ...existing.meta, tokenVersion: existing.meta.tokenVersion + 1 });
      console.log(`${id} tokenVersion is now ${existing.meta.tokenVersion + 1}; minted tokens issued before this are rejected.`);
      console.log(`Connector (OAuth) sign-ins are not versioned: use "agent disable ${id}" to cut those off.`);
    } else throw new Error(HELP);
    return;
  }

  if (group === "allow" || group === "deny") {
    const id = agentId(args[0]);
    const tool = need(args[1], "<tool>");
    const ref = parseCanonical(tool);
    if (!ref) throw new Error(`"${tool}" is not machine.server.tool or machine.server.*`);
    if (!(await store.getAgent(id))) throw new Error(`agent "${id}" does not exist`);
    if (group === "deny") {
      await store.deleteRule(id, tool);
      console.log(`removed rule ${tool} from ${id}`);
      return;
    }
    const json = flag(args, "--rule-json") ?? (flag(args, "--rule-file") ? readFileSync(flag(args, "--rule-file")!, "utf8") : undefined);
    const extra = json ? (JSON.parse(json) as Partial<Rule>) : {};
    const rule = RuleSchema.parse({ ...extra, tool, access: has(args, "--write") ? "write" : "read" });
    await store.putRule(id, rule);
    console.log(`${id} may now ${rule.access === "write" ? "WRITE with" : "read with"} ${tool}`);
    if (tool.endsWith(".*")) console.log("(wildcard: covers the server's read tools only, never its write tools)");
    return;
  }

  if (group === "device") {
    const [cmd, machine, jwkArg] = args;
    if (cmd === "list") {
      const now = Date.now();
      for (const m of await store.listMachines()) {
        const live = m.meta.connectionId && m.meta.lastSeenAt && now - m.meta.lastSeenAt <= OFFLINE_AFTER_MS;
        const seen = m.meta.lastSeenAt ? new Date(m.meta.lastSeenAt).toISOString() : "never";
        console.log(`${m.meta.id.padEnd(10)} ${m.meta.enabled ? "" : "DISABLED "}${live ? "connected" : "offline"}  lastSeen=${seen}  agent=${m.meta.agentVersion ?? "-"}  keys=${m.meta.keys.map((k) => k.kid).join(",")}`);
        for (const s of m.servers) {
          console.log(`  ${s.name.padEnd(12)} ${s.status}  ${s.tools.map((t) => `${t.name}${t.access === "write" ? "(w)" : ""}`).join(" ")}${s.error ? `  [${s.error}]` : ""}`);
        }
      }
      return;
    }
    const id = need(machine, "<machine>");
    if (!isValidName(id)) throw new Error(`invalid machine name "${id}" (lowercase letters and digits, up to 16)`);
    const existing = await store.getMachine(id);
    if (cmd === "register") {
      const jwk = JSON.parse(need(jwkArg, "<public jwk json>")) as { kty?: string; crv?: string; x?: string; d?: string; kid?: string };
      if (jwk.d) throw new Error("that JWK contains a private key (d). Register the PUBLIC key only.");
      if (jwk.kty !== "OKP" || jwk.crv !== "Ed25519" || !jwk.x) throw new Error("expected an Ed25519 public JWK: {kty:'OKP',crv:'Ed25519',x:'...'}");
      const kid = jwk.kid ?? createHash("sha256").update(jwk.x).digest("hex").slice(0, 16);
      const key: DeviceKey = { kid, jwk: { kty: "OKP", crv: "Ed25519", x: jwk.x }, addedAt: Date.now() };
      await store.putMachineRegistration(id, existing?.enabled ?? true, [key]);
      console.log(`registered ${id} with key ${kid}${existing ? " (previous keys replaced)" : ""}`);
      return;
    }
    if (!existing) throw new Error(`machine "${id}" is not registered`);
    if (cmd === "enable" || cmd === "disable") {
      await store.putMachineRegistration(id, cmd === "enable", existing.keys);
      console.log(`${id} ${cmd}d${cmd === "disable" ? " (it can no longer connect; an open connection stops receiving calls)" : ""}`);
      return;
    }
    throw new Error(HELP);
  }

  if (group === "audit" && args[0] === "tail") {
    const day = flag(args, "--day") ?? new Date().toISOString().slice(0, 10);
    const rows = await store.readAudit(day, num(args, "--limit") ?? 25);
    for (const r of rows.reverse()) {
      console.log(
        `${new Date(r.ts).toISOString()} ${r.agent.padEnd(12)} ${r.outcome.padEnd(12)} ${r.tool}  args=${r.argsHash.slice(0, 12)} (${r.argBytes}b) result=${r.resultBytes}b ${r.latencyMs}ms ${r.tokenKind}${r.reason ? ` reason=${r.reason}` : ""}`
      );
    }
    if (rows.length === 0) console.log(`no audit rows for ${day} (UTC)`);
    return;
  }

  throw new Error(HELP);
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
  process.exit(1);
});
