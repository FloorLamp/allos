// PURE TIER — THE #2263 regression fixture: replay a source's recorded run history
// through the real standing derivation, one event at a time, and count how many hours
// it spent escalated.
//
// This is the measurement the issue was opened on. Profile 1's weather history over
// 2026-07-31 → 08-07 held 171 runs, 63 of them successful (37%), with a
// success→success gap of median 2.0 h / p90 6.0 h — and 381 rows written on EVERY
// success, the full rolling forecast window, so no failure ever lost anything. Replayed
// through the rule that shipped, the standing read `failing` for 49 of those 171 hours:
// 29% of the time, on a source whose data was arriving fine.
//
// The defect was that the rule counted CONSECUTIVE FAILED RUNS. For an hourly source
// three runs is three hours of silence, which sits BELOW that source's own p90 gap
// between successes — so ordinary operating variance tripped an escalation threshold.
//
// So this file replays a weather-shaped history under BOTH rules and pins the contrast:
// the old count-based rule escalates on ordinary operation, the silence tolerance does
// not, and a genuinely stopped source still escalates under the new rule — which is
// the half that must not be lost.

import { describe, it, expect } from "vitest";
import {
  consecutiveLeadingFailures,
  sourceStanding,
  standingEscalates,
  STANDING_RUN_WINDOW,
  type SyncEventFacts,
} from "@/lib/integrations/source-state";
import { silenceToleranceMinutes } from "@/lib/integrations/staleness";
import { getIntegration } from "@/lib/integrations/registry";

const HOUR = 60;
// Weather's resolved tolerance: 12 polls × its declared 60-minute cadence.
const WEATHER_TOLERANCE = silenceToleranceMinutes(getIntegration("weather"))!;
// The count-based rule that shipped, replayed for the contrast. It is DELETED from the
// module — restated here only so this file can show what it did.
const RETIRED_FAILING_CONSECUTIVE_RUNS = 3;

const EPOCH = Date.parse("2026-07-31T00:00:00Z");

function instant(hoursFromEpoch: number): string {
  return `${new Date(EPOCH + hoursFromEpoch * 3600_000).toISOString().slice(0, 19)}Z`;
}

// The measured gap distribution, as a repeating cycle of success→success gaps in
// hours: median 2 h, p90 6 h, and — the load-bearing property — a 6-hour gap means
// FIVE consecutive recorded failures, which is what the retired rule read as an
// outage. Deterministic rather than random: a regression fixture that reshuffles is
// not a regression fixture.
const GAP_CYCLE_HOURS = [1, 2, 2, 2, 2, 2, 3, 4, 6, 6];

// A weather-shaped run history, oldest-first: one run every hour, ok on the hours the
// gap cycle lands on and a recorded 503 on every hour in between. Every success writes
// the FULL window (381 cells revised or unchanged), which is why no failure loses
// anything.
function weatherShapedHistory(
  runs: number,
  gaps: readonly number[] = GAP_CYCLE_HOURS
): SyncEventFacts[] {
  const successHours = new Set<number>([0]);
  let h = 0;
  for (let i = 0; h < runs; i++) {
    h += gaps[i % gaps.length];
    if (h < runs) successHours.add(h);
  }
  const out: SyncEventFacts[] = [];
  for (let i = 0; i < runs; i++) {
    const ok = successHours.has(i);
    out.push({
      id: i + 1,
      at: instant(i),
      ok: ok ? 1 : 0,
      inserted: ok ? 0 : null,
      updated: ok ? 16 : null,
      unchanged: ok ? 365 : null,
      written: ok ? 381 : null,
      error: ok ? null : "weather fetch failed (503)",
    });
  }
  return out;
}

// Replay: for each recorded run, derive the standing exactly as getIntegrationState
// would have at that moment — the newest-first STANDING_RUN_WINDOW slice ending at
// this run, the last success at or before it, and this run's own instant as `now`.
function replay(
  history: readonly SyncEventFacts[],
  toleranceMinutes: number | null
): { standings: string[]; escalatedRuns: number } {
  const standings: string[] = [];
  let escalatedRuns = 0;
  for (let i = 0; i < history.length; i++) {
    const window = history.slice(
      Math.max(0, i - STANDING_RUN_WINDOW + 1),
      i + 1
    );
    window.reverse(); // newest-first, the shape the derivation is fed
    const lastSuccess = history.slice(0, i + 1).findLast((e) => e.ok);
    const standing = sourceStanding({
      // Every source replayed here is SCHEDULED (#2301) — a real hourly poll's
      // recorded history is exactly what the silence rule was written for.
      delivery: "scheduled",
      connected: true,
      needsReauth: false,
      latest: window[0],
      recentRuns: window,
      lastSuccessAt: lastSuccess?.at ?? null,
      toleranceMinutes,
      now: history[i].at,
    });
    standings.push(standing);
    if (standingEscalates(standing)) escalatedRuns++;
  }
  return { standings, escalatedRuns };
}

// The same replay under the RETIRED rule, so the contrast is measured rather than
// asserted from memory.
function replayRetiredRule(history: readonly SyncEventFacts[]): number {
  let escalated = 0;
  for (let i = 0; i < history.length; i++) {
    const window = history
      .slice(Math.max(0, i - STANDING_RUN_WINDOW + 1), i + 1)
      .reverse();
    if (
      consecutiveLeadingFailures(window) >= RETIRED_FAILING_CONSECUTIVE_RUNS
    ) {
      escalated++;
    }
  }
  return escalated;
}

function successGapsHours(history: readonly SyncEventFacts[]): number[] {
  const hours = history.filter((e) => e.ok).map((e) => Date.parse(e.at));
  const gaps: number[] = [];
  for (let i = 1; i < hours.length; i++) {
    gaps.push((hours[i] - hours[i - 1]) / 3600_000);
  }
  return gaps.sort((a, b) => a - b);
}

describe("the replayed weather history (#2263)", () => {
  const HISTORY = weatherShapedHistory(171);

  it("is the shape the issue measured — a third of runs succeed, p90 gap 6 h, full window every time", () => {
    const successes = HISTORY.filter((e) => e.ok).length;
    expect(successes / HISTORY.length).toBeGreaterThan(0.3);
    expect(successes / HISTORY.length).toBeLessThan(0.45);
    const gaps = successGapsHours(HISTORY);
    expect(gaps[Math.floor(gaps.length / 2)]).toBe(2); // median 2 h
    expect(gaps[Math.ceil(gaps.length * 0.9) - 1]).toBe(6); // p90 6 h
    // Every success re-fetched the whole rolling window, which is why a failure in
    // between loses nothing: the next good run catches everything up.
    for (const ev of HISTORY.filter((e) => e.ok)) expect(ev.written).toBe(381);
  });

  it("BEFORE: the retired consecutive-run rule escalated on ordinary operation", () => {
    // The measured figure was 49/171 = 29% of hours. The rule fires on every hour of
    // a normal 4- and 6-hour gap, which this source has several of a day.
    const escalated = replayRetiredRule(HISTORY);
    expect(escalated).toBeGreaterThan(0.2 * HISTORY.length);
  });

  it("AFTER: the silence tolerance never escalates it — 29% becomes 0", () => {
    const { escalatedRuns, standings } = replay(HISTORY, WEATHER_TOLERANCE);
    expect(escalatedRuns).toBe(0);
    expect(standings).not.toContain("failing");
    // It is not silently downgraded to green either: the flap is still STATED, as the
    // calm amber fact whose reassurance copy was being suppressed 29% of the time.
    expect(
      standings.filter((s) => s === "intermittent").length
    ).toBeGreaterThan(0.5 * HISTORY.length);
  });
});

describe("the tolerance still catches a provider that genuinely stops", () => {
  it("escalates once the silence passes 12 h, and self-clears on the next success", () => {
    // The same history, then the feed stops: hourly runs keep being recorded (or not —
    // it makes no difference), and nothing succeeds again.
    const history = weatherShapedHistory(60);
    const lastSuccessHour = history.findLastIndex((e) => e.ok);
    for (let h = 60; h < 60 + 20; h++) {
      history.push({
        id: h + 1,
        at: instant(h),
        ok: 0,
        inserted: null,
        updated: null,
        unchanged: null,
        written: null,
        error: "weather fetch failed (503)",
      });
    }
    const { standings } = replay(history, WEATHER_TOLERANCE);
    // Exactly at the tolerance it is still calm; one hour past it, it is broken.
    expect(standings[lastSuccessHour + 12]).toBe("intermittent");
    expect(standings[lastSuccessHour + 13]).toBe("failing");
    expect(standings[standings.length - 1]).toBe("failing");

    // One good run and it is calm again — no lifecycle of its own.
    history.push({
      id: 999,
      at: instant(80),
      ok: 1,
      inserted: 0,
      updated: 16,
      unchanged: 365,
      written: 381,
      error: null,
    });
    const healed = replay(history, WEATHER_TOLERANCE);
    expect(healed.standings[healed.standings.length - 1]).toBe("intermittent");
  });

  // THE case the retired rule could not see AT ALL (#2263 decision 3b): a push
  // source whose device-side failures never reach the server. There are no events to
  // classify — only absence — so a run-count rule has nothing to count.
  it("escalates a PUSH provider that recorded nothing at all, at its declared tolerance", () => {
    const tolerance = silenceToleranceMinutes(
      getIntegration("health-connect")
    )!;
    expect(tolerance).toBe(12 * HOUR);
    const lastPush: SyncEventFacts = {
      id: 1,
      at: instant(0),
      ok: 1,
      inserted: 20,
      updated: 10,
      unchanged: 73,
      written: 103,
    };
    const standingAt = (hours: number) =>
      sourceStanding({
        delivery: "scheduled",
        connected: true,
        needsReauth: false,
        latest: lastPush,
        recentRuns: [lastPush],
        lastSuccessAt: lastPush.at,
        toleranceMinutes: tolerance,
        now: instant(hours),
      });
    // The measured non-outage maximum — Android Doze stretching the interval
    // overnight. It must NEVER escalate.
    expect(standingAt(1.6)).toBe("healthy");
    expect(standingAt(12)).toBe("healthy");
    // The 16.2-hour outage: a retired URL answering 301 that the exporter did not
    // follow, so 29 consecutive pushes failed ON THE DEVICE and nothing arrived.
    expect(standingAt(12.1)).toBe("failing");
    expect(standingAt(16.2)).toBe("failing");
  });
});
