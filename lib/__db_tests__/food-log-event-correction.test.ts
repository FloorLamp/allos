// DB INTEGRATION TIER (issue #1934): correcting an already-logged food serving.
//
// The one-tap surfaces got create + delete and never got correction, and
// delete-and-re-log is NOT equivalent — a re-log stamps the CURRENT instant and window.
// updateFoodLogEventCore edits the ledger row in place instead.
//
// The load-bearing pin here is the COUNTER MOVE. `food_log_events` (the per-tap ledger)
// and `food_log` (the day counter) are one fact in two shapes, and three different
// derived reads sit on top of them:
//
//   • getFoodSlotServingsOnDate — the Telegram nudge's per-slot "(n)" button counts
//   • getFoodMealDays           — the web bar's day counts + per-meal tallies
//   • getWeeklyServingsForGroup — the #580 frequency-target progress
//
// They all recompute live, so the thing that can go wrong is not staleness but
// DOUBLE-COUNTING: a correction that adds at the destination without removing at the
// source. Every case below asserts BOTH ends of the move, plus a total, so an
// increment-without-decrement bug cannot pass.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  logFoodServingCore,
  updateFoodLogEventCore,
} from "@/lib/food-log-write";
import { addProteinGramsCore } from "@/lib/protein-log-write";
import { PROTEIN_NUDGE_KEY } from "@/lib/protein-nudge";
import {
  getFoodMealDays,
  getFoodSlotServingsOnDate,
  getWeeklyServingsForGroup,
} from "@/lib/queries";

function makeProfile(name: string): { profileId: number; anchor: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  return { profileId, anchor: today(profileId) };
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

// Every food_log row the profile has, so a move can be checked against the WHOLE
// counter table rather than just the two coordinates under test.
function allCounters(profileId: number) {
  return db
    .prepare(
      `SELECT date, group_key, servings FROM food_log
        WHERE profile_id = ? ORDER BY date, group_key`
    )
    .all(profileId) as { date: string; group_key: string; servings: number }[];
}

function ledgerRow(profileId: number, id: number) {
  return db
    .prepare(
      `SELECT group_key, date, logged_at, meal_slot FROM food_log_events
        WHERE id = ? AND profile_id = ?`
    )
    .get(id, profileId) as
    | {
        group_key: string;
        date: string;
        logged_at: string;
        meal_slot: string | null;
      }
    | undefined;
}

// The single ledger event id for a profile — every fixture below logs exactly the
// servings it means to inspect, so this is unambiguous by construction.
function onlyEventId(profileId: number): number {
  const rows = db
    .prepare(`SELECT id FROM food_log_events WHERE profile_id = ? ORDER BY id`)
    .all(profileId) as { id: number }[];
  expect(rows).toHaveLength(1);
  return rows[0].id;
}

describe("updateFoodLogEventCore — meal-slot correction (#1934)", () => {
  it("MOVES the slot tally instead of double-counting it", () => {
    const { profileId, anchor } = makeProfile("food-correct-slot");
    logFoodServingCore(
      profileId,
      "leafy_greens",
      anchor,
      `${anchor}T08:00:00Z`,
      "Morning"
    );
    const eventId = onlyEventId(profileId);

    // Before: the nudge counts it in Morning and nowhere else.
    expect(
      getFoodSlotServingsOnDate(profileId, "Morning", anchor).get(
        "leafy_greens"
      )
    ).toBe(1);
    expect(
      getFoodSlotServingsOnDate(profileId, "Evening", anchor).get(
        "leafy_greens"
      )
    ).toBeUndefined();

    const outcome = updateFoodLogEventCore(profileId, eventId, {
      mealSlot: "Evening",
    });
    expect(outcome.kind).toBe("updated");
    if (outcome.kind !== "updated") return;
    expect(outcome.from).toMatchObject({
      mealSlot: "Morning",
      mealServings: 0,
    });
    expect(outcome.to).toMatchObject({ mealSlot: "Evening", mealServings: 1 });

    // After: it counts in Evening, and Morning is EMPTY — the count moved, it did not
    // reproduce. Summing every slot proves there is still exactly one serving.
    expect(
      getFoodSlotServingsOnDate(profileId, "Morning", anchor).get(
        "leafy_greens"
      )
    ).toBeUndefined();
    expect(
      getFoodSlotServingsOnDate(profileId, "Evening", anchor).get(
        "leafy_greens"
      )
    ).toBe(1);
    const perSlot = (["Morning", "Midday", "Evening"] as const).map(
      (slot) =>
        getFoodSlotServingsOnDate(profileId, slot, anchor).get(
          "leafy_greens"
        ) ?? 0
    );
    expect(perSlot.reduce((a, b) => a + b, 0)).toBe(1);

    // The DAY counter is untouched by a slot-only correction: the serving did not
    // change group or day, so food_log has no move to make.
    expect(allCounters(profileId)).toEqual([
      { date: anchor, group_key: "leafy_greens", servings: 1 },
    ]);

    // The web bar's per-meal tally follows the same derivation.
    const [day] = getFoodMealDays(profileId, [anchor]);
    expect(day.slotCounts.Morning.leafy_greens).toBeUndefined();
    expect(day.slotCounts.Evening.leafy_greens).toBe(1);
    expect(day.counts.leafy_greens).toBe(1);
    expect(day.events).toHaveLength(1);
    expect(day.events[0]).toMatchObject({
      id: eventId,
      groupKey: "leafy_greens",
      mealSlot: "Evening",
    });
  });

  it("keeps logged_at as the audit instant across a slot correction", () => {
    const { profileId, anchor } = makeProfile("food-correct-audit-instant");
    const tapped = `${anchor}T08:15:00Z`;
    logFoodServingCore(profileId, "berries", anchor, tapped, "Morning");
    const eventId = onlyEventId(profileId);

    updateFoodLogEventCore(profileId, eventId, { mealSlot: "Evening" });

    // The WINDOW is the corrected grain; the tap instant is history and stays put.
    expect(ledgerRow(profileId, eventId)).toMatchObject({
      logged_at: tapped,
      meal_slot: "Evening",
    });
  });

  it("leaves a legacy NULL meal_slot deriving from logged_at when only the group moves", () => {
    const { profileId, anchor } = makeProfile("food-correct-legacy-null");
    // A pre-#1704 tap: no explicit window, so its slot derives from the instant.
    logFoodServingCore(profileId, "berries", anchor, `${anchor}T08:00:00Z`);
    const eventId = onlyEventId(profileId);

    updateFoodLogEventCore(profileId, eventId, { groupKey: "fruit" });

    // A correction that never asserted a window must not silently freeze one — the
    // row keeps deriving, so a later boundary change still re-buckets it.
    expect(ledgerRow(profileId, eventId)).toMatchObject({
      group_key: "fruit",
      meal_slot: null,
    });
  });
});

describe("updateFoodLogEventCore — group correction (#1934)", () => {
  it("moves the day counter and the weekly target progress with the serving", () => {
    const { profileId, anchor } = makeProfile("food-correct-group");
    logFoodServingCore(
      profileId,
      "berries",
      anchor,
      `${anchor}T09:00:00Z`,
      "Morning"
    );
    const eventId = onlyEventId(profileId);
    expect(getWeeklyServingsForGroup(profileId, "berries")).toBe(1);

    const outcome = updateFoodLogEventCore(profileId, eventId, {
      groupKey: "fruit",
    });
    expect(outcome.kind).toBe("updated");
    if (outcome.kind !== "updated") return;
    expect(outcome.from).toMatchObject({
      groupKey: "berries",
      servings: 0,
      mealServings: 0,
    });
    expect(outcome.to).toMatchObject({
      groupKey: "fruit",
      servings: 1,
      mealServings: 1,
    });

    // The source counter row is GONE (dropped at zero, the undo discipline) and the
    // destination holds the one serving — the whole counter table proves it.
    expect(allCounters(profileId)).toEqual([
      { date: anchor, group_key: "fruit", servings: 1 },
    ]);
    // The #580 frequency-target progress reads the same counter, so it moved too.
    expect(getWeeklyServingsForGroup(profileId, "berries")).toBe(0);
    expect(getWeeklyServingsForGroup(profileId, "fruit")).toBe(1);

    const [day] = getFoodMealDays(profileId, [anchor]);
    expect(day.counts.berries).toBeUndefined();
    expect(day.counts.fruit).toBe(1);
    expect(day.slotCounts.Morning.fruit).toBe(1);
  });

  it("adds to an existing destination count without disturbing the rest of the day", () => {
    const { profileId, anchor } = makeProfile("food-correct-group-merge");
    logFoodServingCore(
      profileId,
      "berries",
      anchor,
      `${anchor}T09:00:00Z`,
      "Morning"
    );
    logFoodServingCore(
      profileId,
      "fruit",
      anchor,
      `${anchor}T09:05:00Z`,
      "Morning"
    );
    logFoodServingCore(
      profileId,
      "fruit",
      anchor,
      `${anchor}T09:10:00Z`,
      "Morning"
    );
    const berriesEvent = db
      .prepare(
        `SELECT id FROM food_log_events
          WHERE profile_id = ? AND group_key = 'berries'`
      )
      .get(profileId) as { id: number };

    updateFoodLogEventCore(profileId, berriesEvent.id, {
      groupKey: "fruit",
    });

    // 1 + 2 servings in, 3 servings out — no serving invented, none lost.
    expect(allCounters(profileId)).toEqual([
      { date: anchor, group_key: "fruit", servings: 3 },
    ]);
    expect(
      getFoodSlotServingsOnDate(profileId, "Morning", anchor).get("fruit")
    ).toBe(3);
  });
});

describe("updateFoodLogEventCore — date correction (#1934)", () => {
  it("moves the serving to the other day's counter and tallies", () => {
    const { profileId, anchor } = makeProfile("food-correct-date");
    const yesterday = shiftDateStr(anchor, -1);
    // "Last night's dinner logged this morning" — the case a re-log cannot repair,
    // because a re-log would stamp today and the current window.
    logFoodServingCore(
      profileId,
      "fatty_fish",
      anchor,
      `${anchor}T07:40:00Z`,
      "Morning"
    );
    const eventId = onlyEventId(profileId);

    const outcome = updateFoodLogEventCore(profileId, eventId, {
      date: yesterday,
      mealSlot: "Evening",
    });
    expect(outcome.kind).toBe("updated");
    if (outcome.kind !== "updated") return;
    expect(outcome.from).toMatchObject({ date: anchor, servings: 0 });
    expect(outcome.to).toMatchObject({ date: yesterday, servings: 1 });

    expect(counter(profileId, "fatty_fish", anchor)).toBe(0);
    expect(counter(profileId, "fatty_fish", yesterday)).toBe(1);
    expect(allCounters(profileId)).toEqual([
      { date: yesterday, group_key: "fatty_fish", servings: 1 },
    ]);

    // Today's slot counts are empty and yesterday's Evening holds it — the day-scoped
    // nudge counts followed the move rather than seeing it twice.
    expect(
      getFoodSlotServingsOnDate(profileId, "Morning", anchor).get("fatty_fish")
    ).toBeUndefined();
    expect(
      getFoodSlotServingsOnDate(profileId, "Evening", yesterday).get(
        "fatty_fish"
      )
    ).toBe(1);

    const [past, present] = getFoodMealDays(profileId, [yesterday, anchor]);
    expect(past.counts.fatty_fish).toBe(1);
    expect(past.events).toHaveLength(1);
    expect(present.counts.fatty_fish).toBeUndefined();
    expect(present.events).toHaveLength(0);
  });
});

describe("updateFoodLogEventCore — typed refusals (#1934)", () => {
  it("refuses another profile's event and writes nothing", () => {
    const { profileId, anchor } = makeProfile("food-correct-owner");
    const other = makeProfile("food-correct-intruder");
    logFoodServingCore(
      profileId,
      "berries",
      anchor,
      `${anchor}T09:00:00Z`,
      "Morning"
    );
    const eventId = onlyEventId(profileId);

    const outcome = updateFoodLogEventCore(other.profileId, eventId, {
      groupKey: "fruit",
    });
    expect(outcome).toEqual({ kind: "not-found" });
    // The victim's row and counter are untouched.
    expect(ledgerRow(profileId, eventId)).toMatchObject({
      group_key: "berries",
      meal_slot: "Morning",
    });
    expect(allCounters(profileId)).toEqual([
      { date: anchor, group_key: "berries", servings: 1 },
    ]);
    expect(allCounters(other.profileId)).toEqual([]);
  });

  it("refuses the reserved protein ranking event", () => {
    const { profileId, anchor } = makeProfile("food-correct-protein");
    addProteinGramsCore(profileId, anchor, 25, `${anchor}T18:00:00Z`);
    const eventId = onlyEventId(profileId);

    const outcome = updateFoodLogEventCore(profileId, eventId, {
      groupKey: "berries",
    });
    // __protein__ is a ranking participant, not a serving: re-keying it would mint a
    // food-group serving out of a shake, and its truth lives in protein_log grams.
    expect(outcome).toEqual({ kind: "not-correctable" });
    expect(ledgerRow(profileId, eventId)).toMatchObject({
      group_key: PROTEIN_NUDGE_KEY,
    });
    expect(allCounters(profileId)).toEqual([]);
  });

  it("refuses an off-catalog group and an unreal date without writing", () => {
    const { profileId, anchor } = makeProfile("food-correct-invalid");
    logFoodServingCore(
      profileId,
      "berries",
      anchor,
      `${anchor}T09:00:00Z`,
      "Morning"
    );
    const eventId = onlyEventId(profileId);

    expect(
      updateFoodLogEventCore(profileId, eventId, { groupKey: "not_a_group" })
    ).toEqual({ kind: "unknown-group" });
    expect(
      updateFoodLogEventCore(profileId, eventId, { date: "2026-02-31" })
    ).toEqual({ kind: "invalid-date" });
    expect(
      updateFoodLogEventCore(profileId, 9_999_999, { mealSlot: "Evening" })
    ).toEqual({ kind: "not-found" });

    expect(ledgerRow(profileId, eventId)).toMatchObject({
      group_key: "berries",
      date: anchor,
      meal_slot: "Morning",
    });
    expect(allCounters(profileId)).toEqual([
      { date: anchor, group_key: "berries", servings: 1 },
    ]);
  });
});
