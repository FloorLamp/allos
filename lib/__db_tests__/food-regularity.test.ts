// DB INTEGRATION TIER (issue #2380): the food-regularity gather and the offer over it.
//
// The pure arithmetic is covered in lib/__tests__/food-regularity.test.ts. What needs a
// database is everything the gather adds to it: the window derivation over real
// food_log_events rows (the #2019 eaten-over-tap precedence included), the declared
// gate producing genuine silence off a real ledger, the cap-direction exclusion — which
// is read out of frequency_targets and the substance catalog — and the offer's
// subtraction of what the window already holds today. It also owns the ATOMICITY case
// for `logUsualFoodCore`, which only a real transaction can prove.

import { describe, it, expect, vi } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import {
  FOOD_REGULARITY_MIN_WINDOW_DAYS,
  FOOD_REGULARITY_SPAN_DAYS,
} from "@/lib/food-regularity";
import { logUsualFoodCore } from "@/lib/food-usual-write";
import {
  getCapDirectionFoodGroups,
  getFoodRegularity,
  getHabitualFoodGroups,
  getUsualFoodOffer,
} from "@/lib/queries";

// The mid-set refusal is UNREACHABLE through the product — `logUsualFoodCore` only ever
// passes catalog slugs it just re-derived — which is exactly why the guard against it
// needs a seam rather than a fixture. This mock is INERT by default (it delegates to the
// real core); a test opts one group into refusing by naming it in `refusal.groupKey`.
const refusal = vi.hoisted(() => ({ groupKey: null as string | null }));
vi.mock("@/lib/food-log-write", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/food-log-write")>();
  return {
    ...actual,
    logFoodServingCore: (
      ...args: Parameters<typeof actual.logFoodServingCore>
    ) =>
      args[1] === refusal.groupKey
        ? ({ kind: "unknown-group" } as const)
        : actual.logFoodServingCore(...args),
  };
});

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

describe("logUsualFoodCore lands the whole set or none of it (#2380)", () => {
  // Twelve mornings of fermented + berries, nothing logged today: the offer is the
  // pair, in share-then-key order (berries, fermented).
  function seedPair(name: string) {
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
        .lastInsertRowid
    );
    setTimezone(profileId, "UTC");
    const anchor = today(profileId);
    for (let d = 1; d <= 12; d++) {
      const date = shiftDateStr(anchor, -d);
      tap(profileId, "fermented", date, "08:00:00");
      tap(profileId, "berries", date, "08:05:00");
    }
    return { profileId, anchor };
  }

  // What today actually holds — the assertion that matters. A `nothing-to-log` outcome
  // is worthless on its own: the defect this pins REPORTED nothing-to-log while a
  // serving sat in the database.
  function writtenToday(profileId: number, date: string) {
    return {
      counters: db
        .prepare(
          `SELECT group_key, servings FROM food_log
            WHERE profile_id = ? AND date = ? ORDER BY group_key`
        )
        .all(profileId, date),
      events: db
        .prepare(
          `SELECT group_key FROM food_log_events
            WHERE profile_id = ? AND date = ? ORDER BY id`
        )
        .all(profileId, date),
    };
  }

  it("rolls back the servings already written when a later one refuses", () => {
    const { profileId, anchor } = seedPair("usual-atomic-refusal");
    expect(getUsualFoodOffer(profileId, "Morning", anchor)).toEqual([
      "berries",
      "fermented",
    ]);

    // `berries` is written FIRST and succeeds; `fermented` then refuses. Returning
    // from inside writeTx would commit the berries serving (better-sqlite3 commits on
    // a normal return and rolls back only on a throw) while answering "nothing was
    // logged" — a half-written set the user was told did not happen.
    refusal.groupKey = "fermented";
    try {
      const outcome = logUsualFoodCore(profileId, "Morning", [
        "berries",
        "fermented",
      ]);
      expect(outcome).toEqual({ kind: "nothing-to-log" });
    } finally {
      refusal.groupKey = null;
    }

    // NOTHING was written — neither the day counter nor its ledger event.
    expect(writtenToday(profileId, anchor)).toEqual({
      counters: [],
      events: [],
    });
    // …so the offer still stands, whole, and the next tap can still take it.
    expect(getUsualFoodOffer(profileId, "Morning", anchor)).toEqual([
      "berries",
      "fermented",
    ]);
  });

  it("writes the whole set once the refusal is gone", () => {
    const { profileId, anchor } = seedPair("usual-atomic-success");
    const outcome = logUsualFoodCore(profileId, "Morning", [
      "berries",
      "fermented",
    ]);

    expect(outcome.kind).toBe("logged");
    expect(writtenToday(profileId, anchor)).toEqual({
      counters: [
        { group_key: "berries", servings: 1 },
        { group_key: "fermented", servings: 1 },
      ],
      events: [{ group_key: "berries" }, { group_key: "fermented" }],
    });
  });

  it("commits nothing and reports nothing when the offer is already empty", () => {
    // The early return's case: no write has happened, so a plain return is correct
    // there — this pins that the two paths agree on the observable outcome.
    const { profileId, anchor } = seedPair("usual-atomic-empty");
    expect(
      logUsualFoodCore(profileId, "Morning", ["red_meat", "alcohol"])
    ).toEqual({ kind: "nothing-to-log" });
    expect(writtenToday(profileId, anchor)).toEqual({
      counters: [],
      events: [],
    });
  });
});
