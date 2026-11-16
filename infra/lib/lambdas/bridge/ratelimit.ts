// Per-agent fixed-window rate limits. Spec section 8.2.
export interface RateDeps {
  takeRate(agent: string, window: string, limit: number, ttlSeconds: number): Promise<boolean>;
  now(): number;
}

export type RateResult = { ok: true } | { ok: false; retryAfterSeconds: number; window: "minute" | "day" };

function stamp(now: number, length: number): string {
  return new Date(now).toISOString().replace(/[-:T]/g, "").slice(0, length);
}

export async function checkRate(
  agent: string,
  limits: { ratePerMinute: number; ratePerDay: number },
  deps: RateDeps
): Promise<RateResult> {
  const now = deps.now();
  if (!(await deps.takeRate(agent, `M#${stamp(now, 12)}`, limits.ratePerMinute, 7200))) {
    return { ok: false, window: "minute", retryAfterSeconds: 60 - new Date(now).getUTCSeconds() };
  }
  if (!(await deps.takeRate(agent, `D#${stamp(now, 8)}`, limits.ratePerDay, 2 * 86_400))) {
    const d = new Date(now);
    const secondsToday = d.getUTCHours() * 3600 + d.getUTCMinutes() * 60 + d.getUTCSeconds();
    return { ok: false, window: "day", retryAfterSeconds: 86_400 - secondsToday };
  }
  return { ok: true };
}
