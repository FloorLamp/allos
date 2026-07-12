import { describe, it, expect } from "vitest";
import { rollupAiUsage, totalStat } from "../ai-usage-rollup";
import type { AiEvent } from "../ai-log";

const NOW = "2026-07-12T09:00:00.000Z";

let seq = 0;
function ev(over: Partial<AiEvent>): AiEvent {
  return {
    id: `id-${seq++}`,
    time: NOW,
    feature: "insight",
    status: "ok",
    ...over,
  };
}

describe("rollupAiUsage", () => {
  it("aggregates calls + tokens per feature × profile", () => {
    const rows = rollupAiUsage(
      [
        ev({
          feature: "extraction",
          profileId: 1,
          usage: { in: 1000, out: 200 },
        }),
        ev({
          feature: "extraction",
          profileId: 1,
          usage: { in: 500, out: 100 },
        }),
        ev({ feature: "insight", profileId: 2, usage: { in: 300, out: 80 } }),
      ],
      NOW
    );
    const ext = rows.find(
      (r) => r.feature === "extraction" && r.profileId === 1
    )!;
    expect(ext.today.calls).toBe(2);
    expect(ext.today.tokensIn).toBe(1500);
    expect(ext.today.tokensOut).toBe(300);
    expect(ext.week.calls).toBe(2);
    const ins = rows.find((r) => r.feature === "insight" && r.profileId === 2)!;
    expect(ins.today.tokensIn).toBe(300);
  });

  it("separates profiles and a null (background) profile", () => {
    const rows = rollupAiUsage(
      [
        ev({ feature: "narrative", profileId: 1, usage: { in: 10, out: 5 } }),
        ev({
          feature: "narrative",
          profileId: null,
          usage: { in: 20, out: 5 },
        }),
      ],
      NOW
    );
    expect(rows).toHaveLength(2);
    expect(rows.some((r) => r.profileId === null)).toBe(true);
  });

  it("counts skipped events as neither calls nor tokens", () => {
    const rows = rollupAiUsage(
      [
        ev({ feature: "insight", profileId: 1, status: "skipped" }),
        ev({
          feature: "insight",
          profileId: 1,
          status: "failed",
        }),
      ],
      NOW
    );
    const r = rows.find((x) => x.feature === "insight")!;
    // failed dispatched (1 call), skipped did not.
    expect(r.today.calls).toBe(1);
    expect(r.today.tokensIn).toBe(0);
  });

  it("splits today from the 7-day window and drops older events", () => {
    const rows = rollupAiUsage(
      [
        ev({ profileId: 1, time: NOW, usage: { in: 100, out: 10 } }), // today
        ev({
          profileId: 1,
          time: "2026-07-08T09:00:00.000Z", // 4 days ago (in week)
          usage: { in: 50, out: 5 },
        }),
        ev({
          profileId: 1,
          time: "2026-07-01T09:00:00.000Z", // 11 days ago (out of week)
          usage: { in: 999, out: 999 },
        }),
      ],
      NOW
    );
    const r = rows.find((x) => x.feature === "insight" && x.profileId === 1)!;
    expect(r.today.calls).toBe(1);
    expect(r.today.tokensIn).toBe(100);
    expect(r.week.calls).toBe(2); // today + 4-days-ago; the 11-days-ago dropped
    expect(r.week.tokensIn).toBe(150);
  });

  it("sorts heaviest 7-day token consumers first", () => {
    const rows = rollupAiUsage(
      [
        ev({ feature: "insight", profileId: 1, usage: { in: 10, out: 1 } }),
        ev({
          feature: "extraction",
          profileId: 2,
          usage: { in: 5000, out: 900 },
        }),
      ],
      NOW
    );
    expect(rows[0].feature).toBe("extraction");
  });

  it("totalStat sums a window across rows", () => {
    const rows = rollupAiUsage(
      [
        ev({ feature: "insight", profileId: 1, usage: { in: 100, out: 10 } }),
        ev({
          feature: "extraction",
          profileId: 2,
          usage: { in: 200, out: 20 },
        }),
      ],
      NOW
    );
    const t = totalStat(rows, "today");
    expect(t.calls).toBe(2);
    expect(t.tokensIn).toBe(300);
    expect(t.tokensOut).toBe(30);
  });
});
