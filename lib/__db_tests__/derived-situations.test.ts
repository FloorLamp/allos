// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Issues #1292 (Poor sleep) / #1298 (Period) — the derived-situations resolvers over a
// realistic fixture. The pure rules are pinned in lib/__tests__/derived-situations.test.ts;
// this seeds real sleep sessions + cycle periods + situational items and asserts the
// END-TO-END dueness: a sleep-keyed item goes due on a derived rough night (not a good
// one; the override suppresses it), an iron item goes due on a logged menses day (not a
// mid-cycle day), and the shared state lines render — the #448 builder+fixture standing.
//
// Runs via `npm run test:db` (vitest.db.config.ts). The `db` singleton is pointed at a
// throwaway per-file temp DB by lib/__db_tests__/setup.ts.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import {
  upsertMetricSamples,
  type NormMetricSample,
} from "@/lib/integrations/normalize";
import { resolveSituationId } from "@/lib/settings/profile-attrs";
import { setActiveSituations } from "@/lib/settings";
import { createCycleRow } from "@/lib/cycle-store";
import {
  getEffectiveActiveSituations,
  getDerivedSituationLines,
  resolveDerivedSituations,
  getSituationalDueCount,
} from "@/lib/queries";
import { dismissFinding, restoreFinding } from "@/lib/queries";
import { poorSleepOverrideKey } from "@/lib/derived-situations";

let seq = 0;
function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`${name}-${seq++}`)
      .lastInsertRowid
  );
  setTimezone(id, "UTC");
  return id;
}

// A sleep_min session on `wakeDay` of `minutes`, window ending at wake time (start =
// end − minutes), stored as UTC instants so wall-clock == instant under UTC tz.
function night(wakeDay: string, minutes: number): NormMetricSample {
  const endH = Math.floor(minutes / 60);
  const endM = minutes % 60;
  const end = `${wakeDay}T${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}:00Z`;
  const start = `${shiftDateStr(wakeDay, -1)}T23:00:00Z`;
  return {
    metric: "sleep_min",
    date: wakeDay,
    start_time: start,
    end_time: end,
    value: minutes,
  };
}

// Seed the trailing baseline of good ~8h nights, then last night of `lastNightMin`.
function seedNights(profileId: number, lastNightMin: number): void {
  const anchor = today(profileId);
  const sessions: NormMetricSample[] = [];
  for (let i = 6; i >= 1; i--)
    sessions.push(night(shiftDateStr(anchor, -i), 480));
  sessions.push(night(anchor, lastNightMin));
  upsertMetricSamples(profileId, sessions, "health-connect");
}

// A situational supplement keyed to `situation`, with one bedtime dose.
function keyItem(profileId: number, name: string, situation: string): number {
  const sid = resolveSituationId(profileId, situation)!;
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, kind, condition, priority, situation, situation_id, active, as_needed)
         VALUES (?, ?, 'supplement', 'situational', 'high', ?, ?, 1, 0)`
      )
      .run(profileId, name, situation, sid).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 cap', 'evening', 'any', 0)`
  ).run(itemId);
  return itemId;
}

describe("poor-sleep derived context (#1292)", () => {
  it("a sleep-keyed item goes due on a derived rough night", () => {
    const p = newProfile("poor-sleep-rough");
    keyItem(p, "Magnesium Glycinate", "Poor sleep");
    seedNights(p, 300); // 5h vs ~8h baseline → rough

    const anchor = today(p);
    const v = resolveDerivedSituations(p, anchor).poorSleep;
    expect(v).toMatchObject({ on: true, basis: "measured" });
    expect(getEffectiveActiveSituations(p, anchor).has("Poor sleep")).toBe(
      true
    );
    expect(getSituationalDueCount(p)).toBe(1);

    const lines = getDerivedSituationLines(p, anchor);
    expect(lines.poorSleep).toMatch(/Rough night/);
    expect(lines.poorSleep).toMatch(
      /1 sleep-support item active today \(auto\)/
    );
  });

  it("does NOT go due on a good night", () => {
    const p = newProfile("poor-sleep-good");
    keyItem(p, "Magnesium Glycinate", "Poor sleep");
    seedNights(p, 475); // ~8h → not rough

    const anchor = today(p);
    expect(resolveDerivedSituations(p, anchor).poorSleep.on).toBe(false);
    expect(getEffectiveActiveSituations(p, anchor).has("Poor sleep")).toBe(
      false
    );
    expect(getSituationalDueCount(p)).toBe(0);
    expect(getDerivedSituationLines(p, anchor).poorSleep).toBeNull();
  });

  it("the 'Not today' override suppresses the derived contribution for the day", () => {
    const p = newProfile("poor-sleep-override");
    keyItem(p, "Magnesium Glycinate", "Poor sleep");
    seedNights(p, 300);
    const anchor = today(p);

    // Overridden → off; item not due.
    dismissFinding(p, poorSleepOverrideKey(anchor));
    expect(resolveDerivedSituations(p, anchor).poorSleep.on).toBe(false);
    expect(getSituationalDueCount(p)).toBe(0);

    // A DIFFERENT day's override does not affect today (date-scoped).
    restoreFinding(p, poorSleepOverrideKey(anchor));
    dismissFinding(p, poorSleepOverrideKey(shiftDateStr(anchor, -1)));
    expect(resolveDerivedSituations(p, anchor).poorSleep.on).toBe(true);
    expect(getSituationalDueCount(p)).toBe(1);
  });

  it("a DECLARED toggle survives the override (override only touches derived)", () => {
    const p = newProfile("poor-sleep-declared");
    keyItem(p, "Magnesium Glycinate", "Poor sleep");
    seedNights(p, 300);
    const anchor = today(p);
    setActiveSituations(p, ["Poor sleep"]); // declared
    dismissFinding(p, poorSleepOverrideKey(anchor)); // override the derived

    const v = resolveDerivedSituations(p, anchor).poorSleep;
    expect(v).toEqual({ on: true, basis: "declared" });
    expect(getSituationalDueCount(p)).toBe(1); // declared keeps it due
  });
});

describe("period derived context (#1298)", () => {
  it("an iron item keyed to Period is due on a logged menses day, absent mid-cycle", () => {
    const p = newProfile("period-logged");
    keyItem(p, "Iron Bisglycinate", "Period");
    const anchor = today(p);

    // Log an OPEN period starting 2 days ago (covers today). A cycle row also makes
    // cycle tracking RELEVANT, so the built-in Period situation applies.
    createCycleRow(p, shiftDateStr(anchor, -2), null, "medium", null);

    const v = resolveDerivedSituations(p, anchor).period;
    expect(v).toMatchObject({ on: true, basis: "logged" });
    expect(getEffectiveActiveSituations(p, anchor).has("Period")).toBe(true);
    expect(getSituationalDueCount(p)).toBe(1);

    const lines = getDerivedSituationLines(p, anchor);
    expect(lines.period).toBe("Period logged — 1 item active");
  });

  it("is absent on a mid-cycle (gap) day", () => {
    const p = newProfile("period-gap");
    keyItem(p, "Iron Bisglycinate", "Period");
    const anchor = today(p);
    // A CLOSED period that ended 10 days ago — cycle tracking is relevant, but today
    // is a gap day, so Period context is off.
    createCycleRow(
      p,
      shiftDateStr(anchor, -15),
      shiftDateStr(anchor, -10),
      "medium",
      null
    );

    const v = resolveDerivedSituations(p, anchor).period;
    expect(v).toEqual({ on: false, basis: null });
    expect(getEffectiveActiveSituations(p, anchor).has("Period")).toBe(false);
    expect(getSituationalDueCount(p)).toBe(0);
  });

  it("Period is null when cycle tracking is not relevant (no built-in)", () => {
    const p = newProfile("period-not-relevant");
    // No cycle rows, no reproductive attrs → cycle bit off.
    expect(resolveDerivedSituations(p, today(p)).period).toBeNull();
  });
});
