// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issue #2216 constraint 1: no stored slot time changes meaning or stops firing
// because the tick cadence changed — the cadence decides only how promptly a time
// is honoured. This drives the tick's REAL observed-cadence machinery — the
// `notify_tick_last_run_at` watermark and `notify_tick_interval_min` record in the
// global settings store, exactly the block scripts/notify.ts runs at the top of
// every tick (its main() runs on import, so the block is mirrored here the way
// digest-modes.test.ts mirrors the digest block) — through an operator moving the
// sidecar 5 → 15 → 5 minutes, with an off-grid 07:35 slot stored throughout.
//
// What must hold, and does:
//   • the slot fires on its two attempt bands EVERY day, at every cadence;
//   • at 5-minute ticks it fires at 07:35 exactly (offset 0 — it is on that grid);
//   • at 15-minute ticks it fires at 07:45 — late-but-correct, never dropped;
//   • back at 5 it is exact again, with no state to repair: the bands re-derive
//     from the watermark alone;
//   • the Settings warning (subHourlySlotsAtRisk over the RECORDED observed
//     cadence) names 07:35 exactly while the coarser cadence cannot hit it, and
//     says nothing once it can again — guidance tracking reality, never a
//     validation that could strand the stored time.

import { describe, it, expect, beforeEach } from "vitest";
import { deleteSetting, getSetting, setSetting } from "@/lib/settings";
import {
  observedTickMinutes,
  slotAttempt,
  subHourlySlotsAtRisk,
  type SlotAttempt,
} from "@/lib/notifications/schedule";

// The stored slot: 07:35 — on the 5-minute grid, off the 15-minute one.
const SLOT_MINUTE = 7 * 60 + 35;

// UTC day starts, epoch-aligned at midnight so ticks land on minute boundaries the
// way the epoch-aligned sidecar's do. Three consecutive days, one cadence each.
const DAY_ONE_MS = Date.parse("2026-08-04T00:00:00Z");

interface DayRun {
  /** Every (minute, band) on which the slot read due. */
  due: { minute: number; band: SlotAttempt }[];
  /** The observed cadence the settings store records by the slot's first band. */
  recordedAtSlot: number;
}

// One simulated day of ticks at `cadence`, running the SAME watermark block as
// scripts/notify.ts: read the previous tick's instant from the settings store,
// derive the observed interval, write the watermark and the observed record back.
function runDay(dayStartMs: number, cadence: number): DayRun {
  const due: DayRun["due"] = [];
  let recordedAtSlot = NaN;
  for (let minute = 0; minute < 1440; minute += cadence) {
    const nowMs = dayStartMs + minute * 60_000;
    const prevTickMs = Date.parse(getSetting("notify_tick_last_run_at") ?? "");
    const tickMinutes = observedTickMinutes(
      Number.isFinite(prevTickMs) ? prevTickMs : null,
      nowMs
    );
    setSetting("notify_tick_last_run_at", new Date(nowMs).toISOString());
    setSetting("notify_tick_interval_min", String(tickMinutes));
    const band = slotAttempt(SLOT_MINUTE, minute, tickMinutes);
    if (band) {
      if (due.length === 0) recordedAtSlot = tickMinutes;
      due.push({ minute, band });
    }
  }
  return { due, recordedAtSlot };
}

describe("a stored 07:35 across an observed-cadence change 5 → 15 → 5 (#2216)", () => {
  beforeEach(() => {
    deleteSetting("notify_tick_last_run_at");
    deleteSetting("notify_tick_interval_min");
  });

  it("keeps firing on both bands every day, exact on its grid and late-but-correct off it", () => {
    // Day one: the 5-minute sidecar. First tick ever reads hourly (widest safe
    // band), but by 07:35 the watermark has long since measured the real cadence.
    const day1 = runDay(DAY_ONE_MS, 5);
    expect(day1.due).toEqual([
      { minute: SLOT_MINUTE, band: "first" }, // 07:35 exactly — offset 0
      { minute: SLOT_MINUTE + 60, band: "retry" },
    ]);
    expect(day1.recordedAtSlot).toBe(5);

    // The operator moves TICK_SECONDS to 15 minutes. Nothing is migrated, nothing
    // is rewritten: the next day's ticks measure the new rhythm from the watermark
    // and the SAME stored time fires 10 minutes late instead of on the minute.
    const day2 = runDay(DAY_ONE_MS + 86_400_000, 15);
    expect(day2.due).toEqual([
      { minute: 7 * 60 + 45, band: "first" }, // first tick at/after 07:35
      { minute: 8 * 60 + 45, band: "retry" },
    ]);
    expect(day2.recordedAtSlot).toBe(15);
    // The Settings warning reads the RECORDED observation and names the time the
    // cadence cannot hit exactly — while the slot keeps firing above.
    expect(
      subHourlySlotsAtRisk(
        [SLOT_MINUTE],
        Number(getSetting("notify_tick_interval_min"))
      )
    ).toEqual([SLOT_MINUTE]);

    // Back to 5: exact again, self-healed from observation alone.
    const day3 = runDay(DAY_ONE_MS + 2 * 86_400_000, 5);
    expect(day3.due).toEqual([
      { minute: SLOT_MINUTE, band: "first" },
      { minute: SLOT_MINUTE + 60, band: "retry" },
    ]);
    expect(day3.recordedAtSlot).toBe(5);
    expect(
      subHourlySlotsAtRisk(
        [SLOT_MINUTE],
        Number(getSetting("notify_tick_interval_min"))
      )
    ).toEqual([]);
  });

  it("gets exactly two due attempts per day at every offered cadence — the band math is tick-rate invariant", () => {
    // #2121's retry budget, pinned across the whole offered set in one sweep:
    // attempts per slot per day never change with the cadence.
    for (const cadence of [1, 2, 3, 4, 5, 6, 10, 12, 15, 20, 30, 60]) {
      deleteSetting("notify_tick_last_run_at");
      const day = runDay(DAY_ONE_MS, cadence);
      expect(day.due.length, `cadence ${cadence}`).toBe(2);
      expect(day.due.map((d) => d.band), `cadence ${cadence}`).toEqual([
        "first",
        "retry",
      ]);
    }
  });
});
