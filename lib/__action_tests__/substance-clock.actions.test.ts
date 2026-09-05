// A DRINK ON THE CLOCK (#3295 phase 1, parts 1 and 2), end to end: the form's stated
// minute through the action's gate, onto every unit of the entry as `occurred_at`, back
// out through the record as ONE ROW PER DRINK, and onto the day chart as one
// `substance` tick per drink.
//
// A CONSUMABLE IS AN EVENT (owner ruling, 2026-09-04): the day total is a rollup, not
// the editable thing, so two drinks at two hours are two rows and two ticks, and each
// corrects through the food serving's own form.
//
// AND SINCE #5026 PHASE 2, SO DOES EVERY OTHER SUBSTANCE. The negative cases here used
// to be about nicotine, cannabis and custom keys having no minute to claim, because
// `substance_daily_totals` declares no event column — but they DID carry `recorded_at`,
// which is what a permissive read would have answered with, printing a FILING stamp as
// a use time. Phase 2 gave them `substance_log_events`, so the same statement lands on
// the same columns and the same rule keeps a filing stamp off the chart: the row may
// say "logged", the TICK reads the event instant only.

import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import {
  addSubstanceDailyTotalAction,
  correctSubstanceUseAction,
  deleteSubstanceUseAction,
} from "@/app/(app)/medical/substance-use/actions";
import { actAs, createLogin, createProfile, fd } from "./harness";
import { setProfileSetting } from "@/lib/settings";
import { shiftDateStr } from "@/lib/date";
import { gatherHistoryLog, type HistoryGatherOptions } from "@/lib/history";
import {
  deleteFoodLogEventCore,
  updateFoodLogEventCore,
} from "@/lib/food-log-write";
import { getIntradayDay, getSubstanceDailyTotals } from "@/lib/queries";
import {
  deleteFoodLogEvent,
  updateFoodLogEvent,
} from "@/app/(app)/nutrition/actions";

const TZ = "UTC";

function seat(name: string) {
  const login = createLogin();
  const profile = createProfile(name, login.id);
  setProfileSetting(profile.id, "timezone", TZ);
  actAs(login, profile);
  return { login, profile };
}

/** Every alcohol serving event on a day, oldest first. */
function taps(profileId: number, date: string) {
  return db
    .prepare(
      `SELECT occurred_at, time_source FROM food_log_events
        WHERE profile_id = ? AND group_key = 'alcohol' AND date = ? ORDER BY id`
    )
    .all(profileId, date) as {
    occurred_at: string | null;
    time_source: string | null;
  }[];
}

/** The day's counter, which must never disagree with the events above. */
function dayServings(profileId: number, date: string): number {
  const row = db
    .prepare(
      `SELECT servings FROM food_daily_totals
        WHERE profile_id = ? AND group_key = 'alcohol' AND date = ?`
    )
    .get(profileId, date) as { servings: number } | undefined;
  return row?.servings ?? 0;
}

/** The record's rows for one day, and the chart the same gather feeds. */
function dayView(
  loginId: number,
  profileId: number,
  date: string,
  narrow?: Pick<HistoryGatherOptions, "kind" | "item">
) {
  const gather = gatherHistoryLog(profileId, {
    loginId,
    day: date,
    limit: 50,
    ...narrow,
  });
  return {
    rows: gather.rows,
    ticks: getIntradayDay(profileId, date, gather.dayEvents).ticks,
  };
}

describe("a drink states a time (#3295 part 1)", () => {
  it("stamps the stated instant on every unit of the entry, and nothing when none is stated", async () => {
    const { login, profile } = seat("clock-add");
    const date = shiftDateStr(today(profile.id), -2);

    expect(
      (
        await addSubstanceDailyTotalAction(
          fd({
            substance: "alcohol",
            date,
            amount: "2",
            stated_at: `${date}T21:30:00Z`,
          })
        )
      ).kind
    ).toBe("added");
    // BOTH units, because the form collects ONE time for ONE submission: "two drinks
    // at nine" is two rows carrying the same statement, not one timed and one not.
    expect(taps(profile.id, date)).toEqual([
      { occurred_at: `${date}T21:30:00Z`, time_source: "stated" },
      { occurred_at: `${date}T21:30:00Z`, time_source: "stated" },
    ]);

    // The same door with no time stated keeps the honest NULL — the tap stamp is not
    // promoted into a drinking time (#2019/#2053).
    const quiet = shiftDateStr(today(profile.id), -3);
    await addSubstanceDailyTotalAction(
      fd({ substance: "alcohol", date: quiet, amount: "1" })
    );
    expect(taps(profile.id, quiet)).toEqual([
      { occurred_at: null, time_source: null },
    ]);
    expect(dayView(login.id, profile.id, quiet).ticks).toEqual([]);
  });

  // The gate is `judgeStatedAt`, re-asked at the action because a Server Action is
  // independently POST-callable. A refusal costs the MINUTE, never the drink.
  it.each([
    [
      "an instant on another day",
      (d: string) => `${shiftDateStr(d, -1)}T21:30:00Z`,
    ],
    ["a far-future instant", () => "2099-01-01T21:30:00Z"],
    ["an unreadable instant", () => "not-an-instant"],
  ])("drops %s and still records the drink", async (_label, build) => {
    const { profile } = seat(`clock-refuse-${_label.slice(0, 8)}`);
    const date = shiftDateStr(today(profile.id), -1);
    expect(
      (
        await addSubstanceDailyTotalAction(
          fd({
            substance: "alcohol",
            date,
            amount: "1",
            stated_at: build(date),
          })
        )
      ).kind
    ).toBe("added");
    expect(taps(profile.id, date)).toEqual([
      { occurred_at: null, time_source: null },
    ]);
    expect(dayServings(profile.id, date)).toBe(1);
  });

  // THE WIDENING PHASE 2 IS. This case used to assert a REFUSAL — a posted time for a
  // timeless ledger must not be half-kept — and its inverse is now the contract: the
  // store holds the instant, so the statement lands and the record reads it back as one
  // row and one tick per use, the drink's own shape.
  it.each(["nicotine", "cannabis", "Kratom"])(
    "keeps a posted time for %s, one row and one tick per use",
    async (substance) => {
      const { login, profile } = seat(`clock-dayonly-${substance}`);
      const date = shiftDateStr(today(profile.id), -1);
      await addSubstanceDailyTotalAction(
        fd({
          substance,
          date,
          amount: "2",
          stated_at: `${date}T21:30:00Z`,
        })
      );
      // The day counter still rolls them up — it is the cap's substrate and the card's
      // count, and phase 2 did not move it.
      expect(getSubstanceDailyTotals(profile.id, substance)[0]).toMatchObject({
        date,
        amount: 2,
      });
      const { rows, ticks } = dayView(login.id, profile.id, date);
      const uses = rows.filter((r) => r.kind === "substance");
      expect(uses).toHaveLength(2);
      expect(uses[0]).toMatchObject({ clock: "21:30", clockKind: "stated" });
      expect(uses[0].edit).toMatchObject({
        kind: "substance",
        substance,
        eventId: expect.any(Number),
      });
      expect(ticks.map((tick) => tick.minute)).toEqual([21 * 60 + 30, 21 * 60 + 30]);
    }
  );

  // THE CONVERSE, and it is the half a "the time is kept" assertion cannot see: a use
  // nobody timed still keeps a NULL instant, so the row admits its clock is a filing
  // time and the chart is left alone. `recorded_at` IS populated on these rows — the
  // read must not reach for it when it draws.
  it.each(["nicotine", "Kratom"])(
    "leaves an untimed %s use with no instant, and draws no tick for it",
    async (substance) => {
      const { login, profile } = seat(`clock-untimed-${substance}`);
      const date = shiftDateStr(today(profile.id), -1);
      await addSubstanceDailyTotalAction(
        fd({ substance, date, amount: "1" })
      );
      const { rows, ticks } = dayView(login.id, profile.id, date);
      const use = rows.find((r) => r.kind === "substance");
      // It is STILL an event row — a use nobody timed is a use — and it reads like the
      // drink beside it: the record chain's minute, prefixed `logged`.
      expect(use?.clockKind).toBe("logged");
      expect(use?.clock).toMatch(/^logged /);
      // BUT IT DRAWS NOTHING. A backfill's `recorded_at` is the minute somebody typed,
      // on whatever day they typed it; the rail is a map of the person's day, so the
      // mark reads the event instant only.
      expect(ticks).toEqual([]);
    }
  );
});

describe("the record reports the drink's instant (#3295 part 2)", () => {
  it("gives each timed drink its own row, its own clock and its own substance tick", async () => {
    const { login, profile } = seat("clock-read");
    const date = shiftDateStr(today(profile.id), -1);
    // TWO ENTRIES AT TWO HOURS — the ruling's own example. The second is two units, so
    // the day holds three drinks and the rows are not merely one per submission.
    await addSubstanceDailyTotalAction(
      fd({
        substance: "alcohol",
        date,
        amount: "1",
        stated_at: `${date}T21:00:00Z`,
      })
    );
    await addSubstanceDailyTotalAction(
      fd({
        substance: "alcohol",
        date,
        amount: "2",
        stated_at: `${date}T23:00:00Z`,
      })
    );

    const { rows, ticks } = dayView(login.id, profile.id, date);
    const drinks = rows.filter((r) => r.kind === "substance");
    expect(drinks).toHaveLength(3);
    // BARE, not "logged 21:00" — the grammar's whole distinction between a stated time
    // and a filing stamp (this seat's login keeps the 24-hour default). The day total
    // is gone from the record: each row states one drink, and the count derives.
    expect(drinks.map((r) => [r.clock, r.clockKind, r.detail])).toEqual([
      ["23:00", "stated", "1 standard drink"],
      ["23:00", "stated", "1 standard drink"],
      ["21:00", "stated", "1 standard drink"],
    ]);

    // CORRECTED WHERE A SERVING IS CORRECTED (the ruling's question 1): the row carries
    // the FOOD edit payload, addressed to its own event, so `HistoryRows` mounts
    // `FoodServingForm` and the delete removes that one drink.
    for (const drink of drinks) {
      expect(drink.edit).toMatchObject({
        kind: "food",
        groupKey: "alcohol",
        clockKind: "stated",
      });
      expect(drink.id).toBe(
        `substance:alcohol:${(drink.edit as { eventId: number }).eventId}`
      );
    }

    // TWO MINUTES, THREE MARKS, EVERY ONE A SUBSTANCE. The category is asserted rather
    // than assumed: a drink arriving as `food` would read as a meal on the chart, and
    // the row and the tick must answer "what is this" the same way.
    expect(ticks.map((t) => [t.category, t.minute])).toEqual([
      ["substance", 21 * 60],
      ["substance", 23 * 60],
      ["substance", 23 * 60],
    ]);
    // Every mark anchors on a row the list below actually shows.
    const ids = new Set(drinks.map((r) => r.id));
    for (const tick of ticks) expect(ids.has(tick.eventId)).toBe(true);

    // ONE ACT, ONE ROW — still. The record reads the alcohol events through the same
    // reader the food gather uses, so dropping the food gather's own exclusion would
    // put every drink on the day TWICE, as a `food` row and again as a `substance`
    // one: the 2026-08-29 defect, which the event ruling did not reopen. Ticks alone
    // cannot see it — food rows contribute none — so the row set is asserted.
    expect(rows.filter((r) => r.kind === "food")).toEqual([]);
  });

  // THE CORRECTION SHAPE, EXERCISED RATHER THAN DESCRIBED (the ruling's question 1).
  // The row hands `HistoryRows` a food edit; this is the core behind that door, asked
  // to re-time one drink of three and then delete another. The rollup follows both,
  // which is the whole reason the day total may stop being the editable thing.
  it("re-times and deletes ONE drink of a day, and the rollup follows", async () => {
    const { login, profile } = seat("clock-correct-one");
    const date = shiftDateStr(today(profile.id), -1);
    await addSubstanceDailyTotalAction(
      fd({
        substance: "alcohol",
        date,
        amount: "3",
        stated_at: `${date}T21:00:00Z`,
      })
    );
    const eventIds = () =>
      dayView(login.id, profile.id, date)
        .rows.filter((r) => r.kind === "substance")
        .map((r) => (r.edit as { eventId: number }).eventId);
    const [first, , third] = eventIds();

    expect(
      updateFoodLogEventCore(profile.id, first, {
        date,
        eatenAt: new Date(`${date}T23:15:00Z`),
      }).kind
    ).toBe("updated");
    expect(deleteFoodLogEventCore(profile.id, third).kind).toBe("deleted");

    const { rows, ticks } = dayView(login.id, profile.id, date);
    expect(rows.filter((r) => r.kind === "substance")).toHaveLength(2);
    expect(ticks.map((t) => t.minute)).toEqual([21 * 60, 23 * 60 + 15]);
    // THE ROLLUP IS DERIVED: the counter the cap and the substance card read moved
    // with the delete, so the two never disagree about how many drinks the day held.
    expect(dayServings(profile.id, date)).toBe(2);
  });

  // THE AGE GATE IS WHY A DRINK IS STILL A SUBSTANCE ROW, and it is the reason the
  // 2026-09-04 ruling did NOT amend. Filing drinks under the food kind — the other
  // reading of "the exclusion goes" — would hand a known minor's record its own
  // "Alcohol" rows, because food is gated nowhere.
  //
  // WHAT THIS ADDS over the shipped row guard (history-gather.test.ts, "was reachable
  // past the substance age gate through the food kind"): the CHART. That guard asks
  // for no day, so it holds no `dayEvents` and could not have seen a mark cross the
  // gate — and a mark is new here.
  it("shows a known minor no drink row and no drink mark", async () => {
    const { login, profile } = seat("clock-minor");
    const date = shiftDateStr(today(profile.id), -1);
    await addSubstanceDailyTotalAction(
      fd({
        substance: "alcohol",
        date,
        amount: "1",
        stated_at: `${date}T21:00:00Z`,
      })
    );
    // The drink is on the ledger for an adult…
    expect(dayView(login.id, profile.id, date).rows).not.toEqual([]);
    // …and the same profile, now a known minor, sees neither the row nor the mark.
    setProfileSetting(
      profile.id,
      "birthdate",
      `${new Date().getUTCFullYear() - 12}-04-02`
    );
    const { rows, ticks } = dayView(login.id, profile.id, date);
    expect(rows.filter((r) => /alcohol/i.test(r.title))).toEqual([]);
    expect(ticks).toEqual([]);
  });

  // THE ONE VISIBILITY PREDICATE, in the direction that can break: a drink the
  // reader's filter dropped must not reach the chart either. The push sits inside the
  // substance block, so `?kind=food` — which shows no substance rows — contributes no
  // substance marks, and the block's own life-stage gate is inherited with it.
  it("draws no tick for a drink whose row the reader's filter dropped", async () => {
    const { login, profile } = seat("clock-filtered");
    const date = shiftDateStr(today(profile.id), -1);
    await addSubstanceDailyTotalAction(
      fd({
        substance: "alcohol",
        date,
        amount: "1",
        stated_at: `${date}T21:30:00Z`,
      })
    );
    const filtered = gatherHistoryLog(profile.id, {
      loginId: login.id,
      day: date,
      limit: 50,
      kind: "food",
    });
    expect(filtered.dayEvents).toEqual([]);
    expect(getIntradayDay(profile.id, date, filtered.dayEvents).ticks).toEqual(
      []
    );

    // AND THE SCROLLING READ CARRIES NOTHING EITHER — the panel is a day-view
    // surface, so a read with no day in hand must not pay for, or hand back, chart
    // events. (The shipped assertion of this rule is seeded with a practice and
    // could not have seen a substance row cross it.)
    expect(
      gatherHistoryLog(profile.id, { loginId: login.id, limit: 50 }).dayEvents
    ).toEqual([]);
  });

  // THE ITEM AXIS, WHICH THE DRINKS LOOP HAS TO ASK FOR ITSELF. Alcohol is the only
  // substance with events, so that loop reads its food group unconditionally — narrowing
  // to a different substance drops the day rows below and nothing else. Both halves
  // leak together, which is why they are asserted as one shape: the row, and the mark
  // pushed beside it.
  it("keeps drinks out of another substance's filter, on the rows and on the chart", async () => {
    const { login, profile } = seat("clock-item-axis");
    const date = shiftDateStr(today(profile.id), -1);
    await addSubstanceDailyTotalAction(
      fd({
        substance: "alcohol",
        date,
        amount: "1",
        stated_at: `${date}T21:30:00Z`,
      })
    );
    // Nicotine is the narrowing target, UNTIMED: phase 2 gave it per-event rows, so the
    // arm this guard protects is no longer "a timeless ledger" but "a use nobody stated
    // a minute for" — two rows on the record and nothing on the rail.
    await addSubstanceDailyTotalAction(
      fd({ substance: "nicotine", date, amount: "2" })
    );

    const seen = (item?: string) => {
      const { rows, ticks } = dayView(login.id, profile.id, date, {
        kind: "substance",
        item,
      });
      return {
        rows: rows.map((r) => r.title),
        ticks: ticks.map((t) => t.minute),
      };
    };
    // UNNARROWED FIRST, through the same reader and differing in ONE option, because a
    // filter's emptiness is otherwise satisfied by a fixture that logged no drink.
    expect(seen()).toEqual({
      rows: ["Alcohol", "Nicotine", "Nicotine"],
      ticks: [21 * 60 + 30],
    });
    expect(seen("nicotine")).toEqual({
      rows: ["Nicotine", "Nicotine"],
      ticks: [],
    });
    // AND THE AXIS NARROWS RATHER THAN HIDES: asking for the drinks by name still gets
    // them, which the guard's other wrong spelling — the item test alone — would not.
    expect(seen("alcohol")).toEqual({
      rows: ["Alcohol"],
      ticks: [21 * 60 + 30],
    });
  });

  it("renders an untimed drink as a row that admits its clock is a filing time, and marks nothing", async () => {
    const { login, profile } = seat("clock-untimed");
    const date = shiftDateStr(today(profile.id), -1);
    await addSubstanceDailyTotalAction(
      fd({ substance: "alcohol", date, amount: "1" })
    );
    const { rows, ticks } = dayView(login.id, profile.id, date);
    const drink = rows.find((r) => r.kind === "substance");
    // It is STILL an event row — a drink nobody timed is a drink — and it reads like
    // the serving row beside it: the record chain's minute, prefixed `logged`.
    expect(drink?.clockKind).toBe("logged");
    expect(drink?.clock).toMatch(/^logged /);
    // BUT IT DRAWS NOTHING. A backfill's `recorded_at` is the minute somebody typed,
    // on whatever day they typed it; the rail is a map of the person's day, so the
    // mark reads the event instant only. This is the practice loop's own rule.
    expect(ticks).toEqual([]);
  });
});

// THE TWO CORRECTION DOORS, AND THE ONE THAT CLOSED (#5026 item 1).
//
// This block used to assert the opposite: that the day-count form shrank, grew and
// re-dated a day's drinks, clearing every stated instant as it moved them. That IS the
// flattening the 2026-09-04 ruling rules out — a consumable is an event, the day total
// is a rollup and not the editable thing — so the door is closed, and the same day is
// corrected here one drink at a time through the door the record actually offers.
//
// BOTH DIRECTIONS, ONE FIXTURE, because the two failures are opposite and a fix that
// only closes the day form is half of the answer: a drink nobody can correct anywhere
// is as wrong as a drink corrected by levelling the day.
describe("a use is corrected on its own row, never through the day count (#5026)", () => {
  /** Two drinks, stated at two hours, exactly as the flattening case needs them. */
  async function twoStatedDrinks(name: string) {
    const { login, profile } = seat(name);
    const date = shiftDateStr(today(profile.id), -4);
    const added = await addSubstanceDailyTotalAction(
      fd({
        substance: "alcohol",
        date,
        amount: "1",
        stated_at: `${date}T21:00:00Z`,
      })
    );
    if (added.kind !== "added") throw new Error("first drink was not added");
    await addSubstanceDailyTotalAction(
      fd({
        substance: "alcohol",
        date,
        amount: "1",
        stated_at: `${date}T23:00:00Z`,
      })
    );
    return { login, profile, date, dayId: added.id };
  }

  /** Each drink row the record shows, as the clock it reads and the event its
   *  correction door addresses — keyed on the clock, because the row's identity to a
   *  person is the hour, and id order is not row order. */
  function recordDrinks(loginId: number, profileId: number, date: string) {
    return dayView(loginId, profileId, date)
      .rows.filter((row) => row.kind === "substance")
      .map((row) => ({
        at: row.sortTime,
        door: (row.edit as { kind: string; eventId: number }).kind,
        eventId: (row.edit as { kind: string; eventId: number }).eventId,
      }));
  }

  /** The same, for a substance whose ledger phase 2 built. */
  async function twoStatedUses(name: string, substance: string) {
    const { login, profile } = seat(name);
    const date = shiftDateStr(today(profile.id), -4);
    for (const hour of ["21:00", "23:00"])
      await addSubstanceDailyTotalAction(
        fd({
          substance,
          date,
          amount: "1",
          stated_at: `${date}T${hour}:00Z`,
        })
      );
    return { login, profile, date };
  }

  /** The day's use counter for a substance-log key, the counter's own arm of `taps`. */
  function dayUnits(profileId: number, substance: string, date: string) {
    const row = db
      .prepare(
        `SELECT units FROM substance_daily_totals
          WHERE profile_id = ? AND substance = ? AND date = ?`
      )
      .get(profileId, substance, date) as { units: number } | undefined;
    return row?.units ?? 0;
  }

  // THE SAME STORY ON THE OTHER LEDGER (#5026 phase 2). What used to sit here was the
  // refusal — the day form flattening two stated hours onto one — and that door does
  // not exist any more for any substance. This is the shape that replaced it, asserted
  // against the defect it replaced: correct ONE use, and its neighbour does not move.
  it.each(["nicotine", "Kratom"])(
    "re-times and deletes ONE %s use of a day, and the rollup follows",
    async (substance) => {
      const { login, profile, date } = await twoStatedUses(
        `clock-use-door-${substance}`,
        substance
      );
      const uses = recordDrinks(login.id, profile.id, date);
      expect(uses.map((use) => [use.at, use.door])).toEqual([
        ["23:00", "substance"],
        ["21:00", "substance"],
      ]);
      const first = uses.find((use) => use.at === "21:00")!.eventId;
      const second = uses.find((use) => use.at === "23:00")!.eventId;

      expect(
        await correctSubstanceUseAction(
          fd({
            event_id: String(first),
            profile_id: String(profile.id),
            date,
            stated_at: `${date}T20:15:00Z`,
          })
        )
      ).toEqual({ kind: "updated", eventId: first, date });
      // ONE USE MOVED. The other keeps the hour it was stated at — which is exactly
      // what a day-count correction could not do, and the whole reason it is gone.
      expect(
        recordDrinks(login.id, profile.id, date).map((use) => use.at)
      ).toEqual(["23:00", "20:15"]);

      // And the same door removes ONE use, with the rollup following it down.
      expect(
        await deleteSubstanceUseAction(
          fd({ event_id: String(second), profile_id: String(profile.id) })
        )
      ).toMatchObject({ kind: "deleted" });
      expect(dayUnits(profile.id, substance, date)).toBe(1);
      expect(recordDrinks(login.id, profile.id, date)).toEqual([
        { at: "20:15", door: "substance", eventId: first },
      ]);
    }
  );

  it("corrects the same day through the record's own door, one drink at a time", async () => {
    const { login, profile, date } = await twoStatedDrinks("clock-event-door");
    const drinks = recordDrinks(login.id, profile.id, date);
    // THE OFFER, before the write: each drink is its own row, at its own hour (the
    // record reads a day latest-first), and the door each one opens is the FOOD
    // serving's form (#5025 phase 1).
    expect(drinks.map((drink) => [drink.at, drink.door])).toEqual([
      ["23:00", "food"],
      ["21:00", "food"],
    ]);
    const first = drinks.find((drink) => drink.at === "21:00")!.eventId;
    const second = drinks.find((drink) => drink.at === "23:00")!.eventId;

    // The door the record mounts on a drink row is the food serving's own form, so
    // this is the post that form makes: a wall time on the row's day.
    expect(
      (
        await updateFoodLogEvent(
          fd({
            event_id: String(first),
            profile_id: String(profile.id),
            date,
            occurred_at: "20:15",
          })
        )
      ).ok
    ).toBe(true);
    // ONE DRINK MOVED. The other keeps the hour it was stated at — which is exactly
    // what the day form could not do, and the whole reason it closed.
    expect(recordDrinks(login.id, profile.id, date).map((d) => d.at)).toEqual([
      "23:00",
      "20:15",
    ]);

    // And the same door removes ONE drink, with the rollup following it down.
    expect(
      (
        await deleteFoodLogEvent(
          fd({ event_id: String(second), profile_id: String(profile.id) })
        )
      ).ok
    ).toBe(true);
    expect(dayServings(profile.id, date)).toBe(1);
    expect(recordDrinks(login.id, profile.id, date)).toEqual([
      { at: "20:15", door: "food", eventId: first },
    ]);
  });
});
