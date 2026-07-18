// DB INTEGRATION TIER (issue #950): the food-log EVENT ledger + slot-aware ranking.
//
// Proves (a) logFoodServingCore appends a per-tap food_log_events row in the SAME tx
// as the counter increment (atomic), (b) undoFoodServingCore pops the NEWEST event
// alongside the counter decrement and TOLERATES a pre-ledger counter row (popless
// decrement), and (c) getFoodGroupLogOrder(profileId, window) leads with the group
// this profile taps in THAT window, backfilling with overall frecency — the same
// getFoodGroupLogOrder the web bar and the Telegram nudge both call (one computation,
// #221), with the no-window case unchanged (degrade-to-overall).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { logFoodServingCore, undoFoodServingCore } from "@/lib/food-log-write";
import { getFoodGroupLogOrder } from "@/lib/queries";

function makeProfile(name: string): { profileId: number; anchor: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  return { profileId, anchor: today(profileId) };
}

function events(profileId: number) {
  return db
    .prepare(
      `SELECT group_key, date, logged_at FROM food_log_events
        WHERE profile_id = ? ORDER BY id`
    )
    .all(profileId) as { group_key: string; date: string; logged_at: string }[];
}

function counter(profileId: number, group: string, date: string): number {
  const row = db
    .prepare(
      `SELECT servings FROM food_log
        WHERE profile_id = ? AND date = ? AND group_key = ?`
    )
    .get(profileId, date, group) as { servings: number } | undefined;
  return row?.servings ?? 0;
}

describe("food_log_events ledger atomicity (#950)", () => {
  it("appends one event per serving tap, in the same tx as the counter", () => {
    const { profileId, anchor } = makeProfile("food-events-append");
    logFoodServingCore(profileId, "fatty_fish", anchor, `${anchor}T12:30:00Z`);
    logFoodServingCore(profileId, "fatty_fish", anchor, `${anchor}T18:00:00Z`);

    expect(counter(profileId, "fatty_fish", anchor)).toBe(2);
    const evs = events(profileId);
    expect(evs).toHaveLength(2);
    expect(evs.every((e) => e.group_key === "fatty_fish")).toBe(true);
    expect(evs[0].logged_at).toBe(`${anchor}T12:30:00Z`);
  });

  it("undo pops the NEWEST event alongside the counter decrement", () => {
    const { profileId, anchor } = makeProfile("food-events-undo");
    logFoodServingCore(profileId, "berries", anchor, `${anchor}T08:00:00Z`);
    logFoodServingCore(profileId, "berries", anchor, `${anchor}T20:00:00Z`);

    undoFoodServingCore(profileId, "berries", anchor);
    expect(counter(profileId, "berries", anchor)).toBe(1);
    const evs = events(profileId);
    // The newest (20:00) event was popped; the 08:00 one survives.
    expect(evs).toHaveLength(1);
    expect(evs[0].logged_at).toBe(`${anchor}T08:00:00Z`);
  });

  it("tolerates a pre-ledger counter row (popless decrement, no throw)", () => {
    const { profileId, anchor } = makeProfile("food-events-preledger");
    // Simulate history written BEFORE this migration: a counter row with NO events.
    db.prepare(
      `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, 'legumes', 2)`
    ).run(profileId, anchor);

    expect(() =>
      undoFoodServingCore(profileId, "legumes", anchor)
    ).not.toThrow();
    expect(counter(profileId, "legumes", anchor)).toBe(1); // decremented anyway
    expect(events(profileId)).toHaveLength(0); // nothing to pop
  });
});

describe("getFoodGroupLogOrder slot-aware blend (#950)", () => {
  // Seed a slot-skewed profile: whole_grains is the heavy overall staple, always eaten
  // at breakfast; fatty_fish is a lighter but reliably-midday habit. Default timezone
  // is UTC and default boundaries are 11:00/15:00, so a 08:00Z tap is Morning and a
  // 12:30Z tap is Midday.
  function seedSlotSkewed(name: string) {
    const { profileId, anchor } = makeProfile(name);
    for (let i = 0; i < 6; i++) {
      const d = shiftDateStr(anchor, -i);
      // whole_grains ×2 at breakfast each day.
      logFoodServingCore(profileId, "whole_grains", d, `${d}T08:00:00Z`);
      logFoodServingCore(profileId, "whole_grains", d, `${d}T08:05:00Z`);
      // fatty_fish ×1 at lunch each day.
      logFoodServingCore(profileId, "fatty_fish", d, `${d}T12:30:00Z`);
    }
    return profileId;
  }

  it("leads with the MIDDAY group at midday, even under a heavier morning staple", () => {
    const profileId = seedSlotSkewed("food-order-midday");
    const midday = getFoodGroupLogOrder(profileId, "Midday").map((g) => g.slug);
    expect(midday[0]).toBe("fatty_fish"); // slot leader
  });

  it("leads with the MORNING staple at morning", () => {
    const profileId = seedSlotSkewed("food-order-morning");
    const morning = getFoodGroupLogOrder(profileId, "Morning").map(
      (g) => g.slug
    );
    expect(morning[0]).toBe("whole_grains");
  });

  it("no-window ranking degrades to overall frecency (the heavier staple leads)", () => {
    const profileId = seedSlotSkewed("food-order-overall");
    const overall = getFoodGroupLogOrder(profileId).map((g) => g.slug);
    // whole_grains has 12 servings vs fatty_fish's 6 → it leads the overall order.
    expect(overall.indexOf("whole_grains")).toBeLessThan(
      overall.indexOf("fatty_fish")
    );
  });

  it("a cold slot with no matching taps falls back to overall order (no cliff)", () => {
    const profileId = seedSlotSkewed("food-order-cold");
    // Evening: nothing was ever tapped in the evening, so the evening ranking must
    // equal the no-window (overall) ranking exactly.
    const evening = getFoodGroupLogOrder(profileId, "Evening").map(
      (g) => g.slug
    );
    const overall = getFoodGroupLogOrder(profileId).map((g) => g.slug);
    expect(evening).toEqual(overall);
  });
});
