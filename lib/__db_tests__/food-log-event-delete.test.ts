// DB INTEGRATION TIER (issue #1963): removing ONE named food serving.
//
// The product had no row-scoped delete anywhere. The only removal was the bar's
// group-scoped "−" (undoFoodServingCore), which picks its victim with
// `ORDER BY logged_at DESC` — the newest TAP in the window. #1934 ended the assumption
// that made that coherent: a correction gives a row a user-asserted `meal_slot` while
// deliberately preserving its tap instant, so a serving moved INTO a window is not
// necessarily the newest thing in it, and the group control takes a neighbour.
//
// The pins here are therefore two:
//
//   • THE COUNTER MOVES EXACTLY ONCE with the row, in one transaction, and its row is
//     DROPPED at zero — `food_log_events` and `food_log` are one fact in two shapes, and
//     the derived reads (the nudge's per-slot counts, the web bar's day/meal tallies, the
//     #580 weekly frequency-target progress) all recompute live off the two of them.
//   • THE DELETE TAKES THE ROW IT WAS GIVEN, including in the exact configuration the
//     issue is about, where the group-scoped undo demonstrably takes someone else.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  deleteFoodLogEventCore,
  logFoodServingCore,
  undoFoodServingCore,
  updateFoodLogEventCore,
} from "@/lib/food-log-write";
import { addProteinGramsCore } from "@/lib/protein-log-write";
import { PROTEIN_NUDGE_KEY } from "@/lib/protein-nudge";
import { getFoodMealDays, getWeeklyServingsForGroup } from "@/lib/queries";
import { type FoodSlot } from "@/lib/food-slot";

// Per-window tallies through the meal grouping the web surface renders
// (getFoodMealDays.slotCounts) — the live consumer of the window derivation, standing
// where the retired slot-count query (getFoodSlotServingsOnDate, #2019/#2227) used to.
function slotServingsOnDate(
  profileId: number,
  window: FoodSlot,
  date: string
): Map<string, number> {
  const [day] = getFoodMealDays(profileId, [date]);
  return new Map(Object.entries(day.slotCounts[window]));
}

function makeProfile(name: string): { profileId: number; anchor: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  return { profileId, anchor: today(profileId) };
}

// Log one serving and hand back the ledger id it wrote.
function seed(
  profileId: number,
  group: string,
  date: string,
  at: string,
  slot: "Morning" | "Midday" | "Evening"
): number {
  logFoodServingCore(profileId, group, date, `${date}T${at}Z`, slot);
  const row = db
    .prepare(
      `SELECT id FROM food_log_events WHERE profile_id = ? ORDER BY id DESC LIMIT 1`
    )
    .get(profileId) as { id: number };
  return row.id;
}

// Every food_log row the profile has, so the counter can be checked against the WHOLE
// table rather than just the coordinate under test.
function allCounters(profileId: number) {
  return db
    .prepare(
      `SELECT date, group_key, servings FROM food_log
        WHERE profile_id = ? ORDER BY date, group_key`
    )
    .all(profileId) as { date: string; group_key: string; servings: number }[];
}

function ledgerIds(profileId: number): number[] {
  return (
    db
      .prepare(
        `SELECT id FROM food_log_events WHERE profile_id = ? ORDER BY id`
      )
      .all(profileId) as { id: number }[]
  ).map((r) => r.id);
}

describe("deleteFoodLogEventCore — the counter moves with the row (#1963)", () => {
  it("removes one serving of several and decrements the day counter exactly once", () => {
    const { profileId, anchor } = makeProfile("food-delete-one-of-many");
    const first = seed(profileId, "berries", anchor, "08:00:00", "Morning");
    seed(profileId, "berries", anchor, "12:30:00", "Midday");
    seed(profileId, "berries", anchor, "19:00:00", "Evening");
    expect(allCounters(profileId)).toEqual([
      { date: anchor, group_key: "berries", servings: 3 },
    ]);

    const outcome = deleteFoodLogEventCore(profileId, first);
    expect(outcome.kind).toBe("deleted");
    if (outcome.kind !== "deleted") return;
    // The vacated placement is the authoritative post-write truth for that coordinate:
    // the day is down to two, and Morning holds none of them.
    expect(outcome.vacated).toEqual({
      date: anchor,
      groupKey: "berries",
      mealSlot: "Morning",
      servings: 2,
      mealServings: 0,
    });

    expect(ledgerIds(profileId)).toHaveLength(2);
    expect(ledgerIds(profileId)).not.toContain(first);
    expect(allCounters(profileId)).toEqual([
      { date: anchor, group_key: "berries", servings: 2 },
    ]);
    // The three derived reads agree: Morning lost its serving, the other two windows
    // kept theirs, and the weekly frequency-target progress is down by exactly one.
    expect(
      slotServingsOnDate(profileId, "Morning", anchor).get("berries")
    ).toBeUndefined();
    expect(slotServingsOnDate(profileId, "Midday", anchor).get("berries")).toBe(
      1
    );
    expect(
      slotServingsOnDate(profileId, "Evening", anchor).get("berries")
    ).toBe(1);
    expect(getWeeklyServingsForGroup(profileId, "berries")).toBe(2);
    const [day] = getFoodMealDays(profileId, [anchor]);
    expect(day.counts.berries).toBe(2);
    expect(day.events.map((e) => e.id)).not.toContain(first);
    expect(day.events).toHaveLength(2);
  });

  it("drops the counter row when the group's last serving goes", () => {
    const { profileId, anchor } = makeProfile("food-delete-last");
    const only = seed(profileId, "fatty_fish", anchor, "18:00:00", "Evening");
    seed(profileId, "leafy_greens", anchor, "18:05:00", "Evening");

    const outcome = deleteFoodLogEventCore(profileId, only);
    expect(outcome.kind).toBe("deleted");
    if (outcome.kind !== "deleted") return;
    expect(outcome.vacated).toEqual({
      date: anchor,
      groupKey: "fatty_fish",
      mealSlot: "Evening",
      servings: 0,
      mealServings: 0,
    });

    // No stray zero row is left behind — the undoFoodServingCore discipline. The
    // neighbouring group is untouched, so the drop is scoped and not a day wipe.
    expect(allCounters(profileId)).toEqual([
      { date: anchor, group_key: "leafy_greens", servings: 1 },
    ]);
    expect(getWeeklyServingsForGroup(profileId, "fatty_fish")).toBe(0);
    const [day] = getFoodMealDays(profileId, [anchor]);
    expect(day.counts.fatty_fish).toBeUndefined();
    expect(day.counts.leafy_greens).toBe(1);
  });

  it("takes the CORRECTED row the group-scoped undo would have missed", () => {
    // THE ISSUE, in its minimal form. Two servings of one group end up in Evening: one
    // logged there, and one logged in the MORNING and corrected into Evening — which
    // keeps its original tap instant (#1934), so it is the OLDER of the two.
    const { profileId, anchor } = makeProfile("food-delete-corrected");
    const corrected = seed(profileId, "berries", anchor, "08:00:00", "Morning");
    const untouched = seed(profileId, "berries", anchor, "19:00:00", "Evening");
    expect(
      updateFoodLogEventCore(profileId, corrected, { mealSlot: "Evening" }).kind
    ).toBe("updated");
    expect(
      slotServingsOnDate(profileId, "Evening", anchor).get("berries")
    ).toBe(2);

    // The row-scoped delete takes the row it was NAMED, regardless of tap instant.
    const outcome = deleteFoodLogEventCore(profileId, corrected);
    expect(outcome.kind).toBe("deleted");
    if (outcome.kind !== "deleted") return;
    expect(outcome.vacated).toEqual({
      date: anchor,
      groupKey: "berries",
      mealSlot: "Evening",
      servings: 1,
      mealServings: 1,
    });
    expect(ledgerIds(profileId)).toEqual([untouched]);
  });

  it("is the answer to a case the group-scoped undo genuinely gets wrong", () => {
    // The control case for the test above, kept so the divergence is DEMONSTRATED rather
    // than asserted in a comment: given the same fixture, `undoFoodServingCore` pops the
    // newest tap in Evening — the serving the user never touched — and the corrected one
    // survives. That behaviour is unchanged by this issue (owner ruling: `bump(-1)` keeps
    // its ordering); the row-scoped delete is what the ⋯ menu offers instead.
    const { profileId, anchor } = makeProfile("food-undo-divergence");
    const corrected = seed(profileId, "berries", anchor, "08:00:00", "Morning");
    const untouched = seed(profileId, "berries", anchor, "19:00:00", "Evening");
    updateFoodLogEventCore(profileId, corrected, { mealSlot: "Evening" });

    undoFoodServingCore(profileId, "berries", anchor, "Evening");
    expect(ledgerIds(profileId)).toEqual([corrected]);
    expect(ledgerIds(profileId)).not.toContain(untouched);
  });
});

describe("deleteFoodLogEventCore — typed refusals (#1963)", () => {
  it("refuses another profile's serving and writes nothing", () => {
    const { profileId, anchor } = makeProfile("food-delete-owner");
    const other = makeProfile("food-delete-intruder");
    const eventId = seed(profileId, "berries", anchor, "09:00:00", "Morning");

    expect(deleteFoodLogEventCore(other.profileId, eventId)).toEqual({
      kind: "not-found",
    });
    // The victim's ledger row and counter are exactly as they were.
    expect(ledgerIds(profileId)).toEqual([eventId]);
    expect(allCounters(profileId)).toEqual([
      { date: anchor, group_key: "berries", servings: 1 },
    ]);
    expect(allCounters(other.profileId)).toEqual([]);
  });

  it("refuses a forged or stale id", () => {
    const { profileId, anchor } = makeProfile("food-delete-missing");
    const eventId = seed(profileId, "berries", anchor, "09:00:00", "Morning");

    expect(deleteFoodLogEventCore(profileId, 9_999_999)).toEqual({
      kind: "not-found",
    });
    // Deleting the same row twice is a refusal, not a second decrement — the counter
    // cannot be walked below the ledger by a double tap.
    expect(deleteFoodLogEventCore(profileId, eventId).kind).toBe("deleted");
    expect(deleteFoodLogEventCore(profileId, eventId)).toEqual({
      kind: "not-found",
    });
    expect(allCounters(profileId)).toEqual([]);
  });

  it("refuses the reserved protein ranking event", () => {
    const { profileId, anchor } = makeProfile("food-delete-protein");
    addProteinGramsCore(profileId, anchor, 25, `${anchor}T18:00:00Z`);
    const [eventId] = ledgerIds(profileId);

    // Same refusal the correction path answers (#1951/#1934), for the same reason: the
    // grams in protein_log are the truth, and popping the ranking row would remove the
    // ledger event while the grams it stands for silently survived.
    expect(deleteFoodLogEventCore(profileId, eventId)).toEqual({
      kind: "not-deletable",
    });
    expect(
      db
        .prepare(`SELECT group_key FROM food_log_events WHERE id = ?`)
        .get(eventId)
    ).toEqual({ group_key: PROTEIN_NUDGE_KEY });
    expect(allCounters(profileId)).toEqual([]);
  });
});
