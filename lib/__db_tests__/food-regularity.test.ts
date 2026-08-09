// DB INTEGRATION TIER (issue #2380): the food-regularity gather and the offer over it.
//
// The pure arithmetic is covered in lib/__tests__/food-regularity.test.ts. What needs a
// database is everything the gather adds to it: the window derivation over real
// food_log_events rows (the #2019 eaten-over-tap precedence included), the declared
// gate producing genuine silence off a real ledger, the cap-direction exclusion — which
// is read out of frequency_targets and the substance catalog — and the offer's
// subtraction of what the window already holds today.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import {
  FOOD_REGULARITY_MIN_WINDOW_DAYS,
  FOOD_REGULARITY_SPAN_DAYS,
} from "@/lib/food-regularity";
import {
  getCapDirectionFoodGroups,
  getFoodRegularity,
  getHabitualFoodGroups,
  getUsualFoodOffer,
} from "@/lib/queries";

function makeProfile(name: string): { profileId: number; anchor: string } {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  // UTC + the default 11:00/15:00 boundaries, so an 08:00Z tap is unambiguously
  // Morning and a 19:00Z one unambiguously Evening.
  setTimezone(profileId, "UTC");
  return { profileId, anchor: today(profileId) };
}

// One tap: the day counter plus its ledger event, at a fixed UTC wall time.
function tap(
  profileId: number,
  group: string,
  date: string,
  hhmmss: string,
  extra: { mealSlot?: string; eatenAt?: string } = {}
): void {
  db.prepare(
    `INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, 1)
       ON CONFLICT(profile_id, date, group_key)
       DO UPDATE SET servings = servings + 1`
  ).run(profileId, date, group);
  db.prepare(
    `INSERT INTO food_log_events
       (profile_id, group_key, date, logged_at, meal_slot, eaten_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    profileId,
    group,
    date,
    `${date}T${hhmmss}Z`,
    extra.mealSlot ?? null,
    extra.eatenAt ?? null
  );
}

describe("getFoodRegularity (#2380)", () => {
  it("measures each window over the days that window was logged", () => {
    const { profileId, anchor } = makeProfile("regularity-basic");
    // Ten mornings: fermented on all ten, berries on six. Two of those days also
    // carry an evening serving — too few evenings to clear the gate.
    for (let d = 1; d <= 10; d++) {
      const date = shiftDateStr(anchor, -d);
      tap(profileId, "fermented", date, "08:00:00");
      if (d <= 6) tap(profileId, "berries", date, "08:30:00");
      if (d <= 2) tap(profileId, "red_meat", date, "19:00:00");
    }

    const measure = getFoodRegularity(profileId);
    expect(measure.Morning).not.toBeNull();
    expect(measure.Morning!.observedDays).toBe(10);
    expect(measure.Morning!.groups).toEqual([
      { groupKey: "fermented", days: 10, share: 1 },
      { groupKey: "berries", days: 6, share: 0.6 },
    ]);
    // Two evenings is under the gate — silence, not a weak habit.
    expect(measure.Evening).toBeNull();
    expect(measure.Midday).toBeNull();
  });

  it(`is silent at ${FOOD_REGULARITY_MIN_WINDOW_DAYS - 1} observed days and speaks at ${FOOD_REGULARITY_MIN_WINDOW_DAYS}`, () => {
    const { profileId, anchor } = makeProfile("regularity-gate");
    for (let d = 1; d <= FOOD_REGULARITY_MIN_WINDOW_DAYS - 1; d++)
      tap(profileId, "eggs", shiftDateStr(anchor, -d), "08:00:00");
    expect(getFoodRegularity(profileId).Morning).toBeNull();
    expect(getHabitualFoodGroups(profileId).Morning).toEqual([]);

    tap(
      profileId,
      "eggs",
      shiftDateStr(anchor, -FOOD_REGULARITY_MIN_WINDOW_DAYS),
      "08:00:00"
    );
    expect(getFoodRegularity(profileId).Morning?.observedDays).toBe(
      FOOD_REGULARITY_MIN_WINDOW_DAYS
    );
    expect(getHabitualFoodGroups(profileId).Morning).toEqual(["eggs"]);
  });

  it("drops history older than the bounded span", () => {
    const { profileId, anchor } = makeProfile("regularity-span");
    for (let d = 1; d <= 20; d++)
      tap(
        profileId,
        "eggs",
        shiftDateStr(anchor, -(d + FOOD_REGULARITY_SPAN_DAYS)),
        "08:00:00"
      );
    expect(getFoodRegularity(profileId).Morning).toBeNull();
  });

  it("files a serving by its EATING instant, not its tap stamp (#2019)", () => {
    const { profileId, anchor } = makeProfile("regularity-eaten-at");
    // Ten dinners TAPPED at 23:40 (Evening either way) and ten breakfasts tapped
    // late in the evening but STATED as eaten at 08:00 — the window follows the
    // eating instant, so these are mornings.
    for (let d = 1; d <= 10; d++) {
      const date = shiftDateStr(anchor, -d);
      tap(profileId, "berries", date, "23:40:00", {
        eatenAt: `${date}T08:00:00Z`,
      });
    }
    const measure = getFoodRegularity(profileId);
    expect(measure.Morning?.groups.map((g) => g.groupKey)).toEqual(["berries"]);
    expect(measure.Evening).toBeNull();
  });

  it("honors an explicit meal declaration over both instants", () => {
    const { profileId, anchor } = makeProfile("regularity-declared");
    for (let d = 1; d <= 10; d++)
      tap(profileId, "nuts_seeds", shiftDateStr(anchor, -d), "08:00:00", {
        mealSlot: "Evening",
      });
    const measure = getFoodRegularity(profileId);
    expect(measure.Evening?.groups.map((g) => g.groupKey)).toEqual([
      "nuts_seeds",
    ]);
    expect(measure.Morning).toBeNull();
  });

  it("ignores the reserved protein key — a habit has to be a catalog group", () => {
    const { profileId, anchor } = makeProfile("regularity-protein-key");
    for (let d = 1; d <= 10; d++) {
      const date = shiftDateStr(anchor, -d);
      db.prepare(
        `INSERT INTO food_log_events (profile_id, group_key, date, logged_at)
         VALUES (?, '__protein__', ?, ?)`
      ).run(profileId, date, `${date}T08:00:00Z`);
    }
    expect(getFoodRegularity(profileId).Morning).toBeNull();
  });
});

describe("cap-direction groups are measured but never presented (#2380 / #998)", () => {
  it("excludes alcohol from the habitual set whether or not a cap is declared", () => {
    const { profileId, anchor } = makeProfile("regularity-alcohol");
    for (let d = 1; d <= 10; d++) {
      const date = shiftDateStr(anchor, -d);
      tap(profileId, "alcohol", date, "19:00:00");
      tap(profileId, "berries", date, "19:30:00");
    }
    // The MEASURE is complete — the cadence ledger's own cap reporting is entitled
    // to the data.
    expect(
      getFoodRegularity(profileId).Evening!.groups.map((g) => g.groupKey)
    ).toContain("alcohol");
    // The presentable half is not.
    expect(getCapDirectionFoodGroups(profileId).has("alcohol")).toBe(true);
    expect(getHabitualFoodGroups(profileId).Evening).toEqual(["berries"]);
    expect(getUsualFoodOffer(profileId, "Evening", today(profileId))).toEqual(
      []
    );
  });

  it("selects the exclusion by DIRECTION, so a declared substance cap is included", () => {
    const { profileId } = makeProfile("regularity-cap-direction");
    db.prepare(
      `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
       VALUES (?, 'substance', 'alcohol', 4)`
    ).run(profileId);
    // A FLOOR target on a food group is not an exclusion — a habit you are trying to
    // build is exactly one the app may name.
    db.prepare(
      `INSERT INTO frequency_targets (profile_id, scope_kind, scope_value, per_week)
       VALUES (?, 'food_group', 'fatty_fish', 2)`
    ).run(profileId);
    const excluded = getCapDirectionFoodGroups(profileId);
    expect(excluded.has("alcohol")).toBe(true);
    expect(excluded.has("fatty_fish")).toBe(false);
  });
});

describe("getUsualFoodOffer (#2380)", () => {
  function seedMorningHabit(name: string) {
    const made = makeProfile(name);
    for (let d = 1; d <= 12; d++) {
      const date = shiftDateStr(made.anchor, -d);
      tap(made.profileId, "fermented", date, "08:00:00");
      tap(made.profileId, "berries", date, "08:05:00");
    }
    return made;
  }

  it("offers the habitual groups the window has nothing logged for yet", () => {
    const { profileId, anchor } = seedMorningHabit("offer-open");
    expect(getUsualFoodOffer(profileId, "Morning", anchor)).toEqual([
      "berries",
      "fermented",
    ]);
  });

  it("collapses to silence once one of the pair is logged — the bar is one tap", () => {
    const { profileId, anchor } = seedMorningHabit("offer-partial");
    tap(profileId, "berries", anchor, "08:02:00");
    expect(getUsualFoodOffer(profileId, "Morning", anchor)).toEqual([]);
  });

  it("offers nothing for a window with no habit", () => {
    const { profileId, anchor } = seedMorningHabit("offer-other-window");
    expect(getUsualFoodOffer(profileId, "Evening", anchor)).toEqual([]);
  });
});
