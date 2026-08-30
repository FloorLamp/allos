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
  USUAL_BACKFILL_WINDOW_DAYS,
} from "@/lib/food-regularity";
import { logUsualFoodCore } from "@/lib/food-usual-write";
import { logFoodServingCore } from "@/lib/food-log-write";
import { USUAL_BACKFILL, type LoggedVia } from "@/lib/logged-via";
import {
  getCapDirectionFoodGroups,
  getFoodRegularity,
  getHabitualFoodGroups,
  getUsualFoodOffer,
} from "@/lib/queries";
import { usualRoutineDayOffers } from "@/lib/queries/usual-routine";

// The mid-set refusal is UNREACHABLE through the product — `logUsualFoodCore` only ever
// passes catalog slugs it just re-derived — which is exactly why the guard against it
// needs a seam rather than a fixture. This mock is INERT by default (it delegates to the
// real core); a test opts one group into refusing by naming it in `refusal.groupKey`.
const refusal = vi.hoisted(() => ({ groupKey: null as string | null }));
vi.mock("@/lib/food-log-write", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/food-log-write")>();
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
    `INSERT INTO food_daily_totals (profile_id, date, group_key, servings) VALUES (?, ?, ?, 1)
       ON CONFLICT(profile_id, date, group_key)
       DO UPDATE SET servings = servings + 1`
  ).run(profileId, date, group);
  db.prepare(
    `INSERT INTO food_log_events
       (profile_id, group_key, date, recorded_at, meal_slot, occurred_at)
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
        `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at)
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
          `SELECT group_key, servings FROM food_daily_totals
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
      const outcome = logUsualFoodCore(
        profileId,
        "Morning",
        anchor,
        ["berries", "fermented"],
        "page"
      );
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
    const outcome = logUsualFoodCore(
      profileId,
      "Morning",
      anchor,
      ["berries", "fermented"],
      "page"
    );

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
      logUsualFoodCore(
        profileId,
        "Morning",
        anchor,
        ["red_meat", "alcohol"],
        "page"
      )
    ).toEqual({ kind: "nothing-to-log" });
    expect(writtenToday(profileId, anchor)).toEqual({
      counters: [],
      events: [],
    });
  });
});

// ── THE EVIDENCE GUARD (#4118) ───────────────────────────────────────────────
//
// The dated usual write is only safe because the rows it makes are not readmitted as
// the reason to offer it again. `getFoodRegularity` excludes `usual-backfill` rows and
// nothing else does — so this needs BOTH directions on ONE fixture, or it proves
// nothing: "backfilled rows are excluded" passes on a ledger with no backfilled rows in
// it, and passes just as well on a guard that excludes EVERYTHING.
//
// THE FIXTURE SITS ONE DAY UNDER THE GATE, which is where the loop actually bites.
// `FOOD_REGULARITY_MIN_WINDOW_DAYS` observed mornings is the difference between silence
// and a habit, so one extra morning is the difference between NO OFFER AT ALL and an
// offer — the largest observable consequence a single day can have, and therefore the
// one worth asserting the guard against.
describe("usual-backfilled rows are not evidence, and everything else still is", () => {
  // One morning short of the gate: two groups on every one of those mornings, so the
  // ONLY thing standing between this profile and an offer is the day count.
  function seedOneShortOfTheGate(name: string) {
    const { profileId, anchor } = makeProfile(name);
    for (let d = 1; d <= FOOD_REGULARITY_MIN_WINDOW_DAYS - 1; d++) {
      const date = shiftDateStr(anchor, -d);
      tap(profileId, "fermented", date, "08:00:00");
      tap(profileId, "berries", date, "08:05:00");
    }
    return { profileId, anchor };
  }

  // The morning that tips it, written with a given provenance — the same two servings
  // either way, on the same day, differing ONLY in the column the guard reads.
  function addTheTippingMorning(
    profileId: number,
    date: string,
    via: LoggedVia
  ) {
    for (const group of ["fermented", "berries"])
      logFoodServingCore(
        profileId,
        group,
        date,
        via,
        `${date}T08:00:00Z`,
        "Morning"
      );
  }

  it.each([
    ["page", "page", true],
    ["telegram-nudge", "telegram-nudge", true],
    ["usual-backfill", USUAL_BACKFILL, false],
  ] as const)(
    "a morning stamped %s is evidence = %s",
    (_label, via, counts) => {
      const { profileId, anchor } = seedOneShortOfTheGate(`guard-${via}`);
      const gateDay = shiftDateStr(anchor, -FOOD_REGULARITY_MIN_WINDOW_DAYS);
      // Before: under the gate, so no measure and no offer.
      expect(getFoodRegularity(profileId).Morning).toBeNull();
      expect(getUsualFoodOffer(profileId, "Morning", anchor)).toEqual([]);

      addTheTippingMorning(profileId, gateDay, via);

      const measure = getFoodRegularity(profileId).Morning;
      if (counts) {
        expect(measure?.observedDays).toBe(FOOD_REGULARITY_MIN_WINDOW_DAYS);
        expect(getUsualFoodOffer(profileId, "Morning", anchor)).toEqual([
          "berries",
          "fermented",
        ]);
      } else {
        // The guard's own direction: the rows exist, and the measure cannot see them.
        expect(measure).toBeNull();
        expect(getUsualFoodOffer(profileId, "Morning", anchor)).toEqual([]);
      }
      // …and either way the servings ARE on the ledger. A guard that had swallowed the
      // rows themselves would satisfy the null above and be a data-loss bug.
      expect(
        db
          .prepare(
            `SELECT SUM(servings) AS n FROM food_daily_totals
              WHERE profile_id = ? AND date = ?`
          )
          .get(profileId, gateDay) as { n: number }
      ).toEqual({ n: 2 });
    }
  );

  it("a dated logUsualFoodCore writes rows that count for the DAY and not for the measure", () => {
    // End to end through the real write, which is the only place the `usual-backfill`
    // stamp is actually decided. Seven logged mornings, so the offer stands, with a HOLE
    // at day 6 back — the LAST day the bundle may reach (`USUAL_BACKFILL_WINDOW_DAYS`),
    // so this exercises the far edge of the reach rather than a comfortable middle.
    const { profileId, anchor } = makeProfile("guard-end-to-end");
    const empty = shiftDateStr(anchor, -USUAL_BACKFILL_WINDOW_DAYS);
    for (let d = 1; d <= FOOD_REGULARITY_MIN_WINDOW_DAYS + 1; d++) {
      if (d === USUAL_BACKFILL_WINDOW_DAYS) continue;
      const date = shiftDateStr(anchor, -d);
      tap(profileId, "fermented", date, "08:00:00");
      tap(profileId, "berries", date, "08:05:00");
    }
    const before = getFoodRegularity(profileId).Morning!;
    expect(before.observedDays).toBe(FOOD_REGULARITY_MIN_WINDOW_DAYS);

    const outcome = logUsualFoodCore(
      profileId,
      "Morning",
      empty,
      ["berries", "fermented"],
      "page"
    );
    expect(outcome.kind).toBe("logged");

    // Visible where a person looks: that day's window now holds the pair, so the offer
    // FOR THAT DAY is spent and a second tap on it writes nothing.
    expect(getUsualFoodOffer(profileId, "Morning", empty)).toEqual([]);
    // Invisible to the measure: the same observed-day count and the same shares.
    const after = getFoodRegularity(profileId).Morning!;
    expect(after).toEqual(before);
    // The stamp is what makes that true.
    expect(
      db
        .prepare(
          `SELECT DISTINCT logged_via FROM food_log_events
            WHERE profile_id = ? AND date = ?`
        )
        .all(profileId, empty)
    ).toEqual([{ logged_via: USUAL_BACKFILL }]);

    // ONE DAY FURTHER BACK IS OUT OF REACH, and it is a DIFFERENT answer from
    // "nothing to log" — the bundle may not be written there at all, and the surface
    // has to be able to say so rather than reporting an empty offer.
    expect(
      logUsualFoodCore(
        profileId,
        "Morning",
        shiftDateStr(anchor, -(USUAL_BACKFILL_WINDOW_DAYS + 1)),
        ["berries", "fermented"],
        "page"
      )
    ).toEqual({ kind: "invalid-date" });
    // …and TOMORROW is refused by the same bound, which `isDoseDateAccepted` would
    // have allowed: no usual offer has ever named a day nobody has lived through.
    expect(
      logUsualFoodCore(
        profileId,
        "Morning",
        shiftDateStr(anchor, 1),
        ["berries", "fermented"],
        "page"
      )
    ).toEqual({ kind: "invalid-date" });
  });

  it("a CONTEMPORANEOUS usual tap is still evidence, and still stamps its surface", () => {
    // The converse of the test above, on the same shape: the doctrine only ever meant
    // to stop a BACKFILL feeding itself. A person tapping their usual on the day they
    // are living has recorded a real morning, and it counts like any other.
    const { profileId, anchor } = makeProfile("guard-contemporaneous");
    for (let d = 1; d <= FOOD_REGULARITY_MIN_WINDOW_DAYS - 1; d++) {
      const date = shiftDateStr(anchor, -d);
      tap(profileId, "fermented", date, "08:00:00");
      tap(profileId, "berries", date, "08:05:00");
    }
    // Under the gate, and there is therefore nothing to tap — so the pair is written
    // the way a person on that day would have: two ordinary taps.
    for (const group of ["fermented", "berries"])
      logFoodServingCore(
        profileId,
        group,
        anchor,
        "page",
        `${anchor}T08:00:00Z`,
        "Morning"
      );

    expect(getFoodRegularity(profileId).Morning?.observedDays).toBe(
      FOOD_REGULARITY_MIN_WINDOW_DAYS
    );
    expect(
      db
        .prepare(
          `SELECT DISTINCT logged_via FROM food_log_events
            WHERE profile_id = ? AND date = ?`
        )
        .all(profileId, anchor)
    ).toEqual([{ logged_via: "page" }]);
  });
});

// ── THE `/history` DOOR'S OFFER READ (#4118) ─────────────────────────────────
//
// `usualRoutineDayOffers` is the derivation the record's add door renders from, and the
// door's own re-read consults the same function — so what it answers IS what the button
// promises. Three properties, and the last is the one that keeps the affordance honest:
// it must never name a day the write core would refuse.
describe("usualRoutineDayOffers", () => {
  // A habit in TWO windows, with a hole at day 3 back so both stand on that day and
  // neither stands on the days already logged.
  function seedTwoWindows(name: string, hole: number) {
    const { profileId, anchor } = makeProfile(name);
    for (let d = 1; d <= 14; d++) {
      if (d === hole) continue;
      const date = shiftDateStr(anchor, -d);
      tap(profileId, "fermented", date, "08:00:00");
      tap(profileId, "berries", date, "08:05:00");
      tap(profileId, "legumes", date, "19:00:00");
      tap(profileId, "nuts_seeds", date, "19:05:00");
    }
    return { profileId, anchor };
  }

  it("names EVERY window that stands on the day, not the current one", () => {
    // A reader reconstructing a day they have already lived is not standing in any of
    // its windows — the morning they missed is exactly as offerable as the evening, so
    // a `currentFoodSlot`-shaped read would answer with at most one of the two.
    const { profileId, anchor } = seedTwoWindows("door-windows", 3);
    const offers = usualRoutineDayOffers(profileId, shiftDateStr(anchor, -3));
    expect(offers.map((o) => o.window)).toEqual(["Morning", "Evening"]);
    expect(offers[0].food.map((f) => f.slug)).toEqual(["berries", "fermented"]);
    // NAMES, not slugs: a label is a promise and a slug is not a promise anybody can
    // read, so the derivation resolves them rather than leaving it to each surface.
    expect(offers[0].food.map((f) => f.name)).toEqual([
      "Berries",
      "Fermented foods",
    ]);
  });

  it("says nothing about a day whose windows are already logged", () => {
    // The converse of the test above on the same fixture: the seeded days hold the
    // whole habit, so nothing stands on them and the door shows no button. Without
    // this, "offers every window" would pass just as well on a read that offered every
    // window unconditionally.
    const { profileId, anchor } = seedTwoWindows("door-logged", 3);
    expect(usualRoutineDayOffers(profileId, shiftDateStr(anchor, -2))).toEqual(
      []
    );
  });

  it.each([
    ["the last day in reach", -USUAL_BACKFILL_WINDOW_DAYS, false],
    ["one day past the reach", -(USUAL_BACKFILL_WINDOW_DAYS + 1), true],
    ["tomorrow", 1, true],
  ] as const)(
    "%s: the read and the write core agree about whether the day is reachable",
    (_why, delta, silent) => {
      // ONE DECISION, ASKED IN ONE PLACE. The door must never show a button
      // `logUsualRoutineCore` would answer `invalid-date` to, so the read is bounded by
      // the same predicate the core gates on — asserted here against the CORE's own
      // verdict rather than against a repeated constant, so the two cannot drift.
      //
      // THE HOLE IS AT THE TARGET DAY, so the ONLY thing that can silence the read is
      // the reach. Seeded over it, the day's windows would already be full and the read
      // would answer `[]` for a reason this test is not about — green on both sides of
      // the bound, which is precisely the shape that must not ship here.
      const { profileId, anchor } = seedTwoWindows(
        `door-reach${delta}`,
        Math.max(0, -delta)
      );
      const target = shiftDateStr(anchor, delta);
      expect(usualRoutineDayOffers(profileId, target).length === 0).toBe(
        silent
      );
      const write = logUsualFoodCore(
        profileId,
        "Morning",
        target,
        ["berries", "fermented"],
        "page"
      );
      expect(write.kind === "invalid-date").toBe(silent);
    }
  );
});
