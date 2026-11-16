import { checkRate } from "../../lib/lambdas/bridge/ratelimit";

function fakeCounters() {
  const counts = new Map<string, number>();
  return {
    counts,
    takeRate: async (agent: string, window: string, limit: number) => {
      const k = `${agent}/${window}`;
      const n = counts.get(k) ?? 0;
      if (n >= limit) return false;
      counts.set(k, n + 1);
      return true;
    },
  };
}

describe("rate limit", () => {
  const now = () => Date.UTC(2026, 10, 15, 12, 0, 20);

  it("refuses the call after the per-minute limit with a retry-after", async () => {
    const c = fakeCounters();
    const limits = { ratePerMinute: 30, ratePerDay: 1000 };
    for (let i = 0; i < 30; i++) expect((await checkRate("coach", limits, { ...c, now })).ok).toBe(true);
    expect(await checkRate("coach", limits, { ...c, now })).toEqual({ ok: false, window: "minute", retryAfterSeconds: 40 });
  });

  it("keeps agents separate", async () => {
    const c = fakeCounters();
    const limits = { ratePerMinute: 1, ratePerDay: 1000 };
    expect((await checkRate("coach", limits, { ...c, now })).ok).toBe(true);
    expect((await checkRate("people", limits, { ...c, now })).ok).toBe(true);
    expect((await checkRate("coach", limits, { ...c, now })).ok).toBe(false);
  });

  it("refuses after the per-day limit", async () => {
    const c = fakeCounters();
    const limits = { ratePerMinute: 100, ratePerDay: 2 };
    await checkRate("coach", limits, { ...c, now });
    await checkRate("coach", limits, { ...c, now });
    const r = await checkRate("coach", limits, { ...c, now });
    expect(r.ok === false && r.window).toBe("day");
  });
});
