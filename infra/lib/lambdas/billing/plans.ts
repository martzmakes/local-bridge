import type { Machine } from "../bridge/store";

export const HOSTED_PLANS = {
  free: { machines: 1, serversPerMachine: 3, callsPerMonth: 300 },
  plus: { machines: 3, serversPerMachine: 10, callsPerMonth: 3_000 },
} as const;

export type HostedPlan = keyof typeof HOSTED_PLANS;

export const PLUS_LOOKUP_KEYS = {
  monthly: "local_bridge_plus_monthly",
  annual: "local_bridge_plus_annual",
} as const;

export function limitHostedCatalog(machines: Machine[], plan: HostedPlan): Machine[] {
  const limits = HOSTED_PLANS[plan];
  return machines.filter(machine => machine.meta.enabled).slice(0, limits.machines)
    .map(machine => ({ ...machine, servers: machine.servers.slice(0, limits.serversPerMachine) }));
}
