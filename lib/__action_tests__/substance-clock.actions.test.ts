// A DRINK ON THE CLOCK (#3295 phase 1, parts 1 and 2), end to end: the form's stated
// minute through the action's gate, onto every unit of the entry as `occurred_at`, back
// out through the record as ONE ROW PER DRINK, and onto the day chart as one
// `substance` tick per drink.
//
// A CONSUMABLE IS AN EVENT (owner ruling, 2026-09-04): the day total is a rollup, not
// the editable thing, so two drinks at two hours are two rows and two ticks, and each
// corrects through the food serving's own form.
//
// THE DAY-ONLY ARM IS THE POINT OF THE NEGATIVE CASES. `substance_daily_totals` is
// UNIQUE per (profile, date, substance) and declares no event column, so nicotine,
// cannabis and custom substances have no minute to claim — but they DO carry
// `recorded_at`, which is what `bestKnownInstant` would answer with. A permissive read
// there prints a FILING stamp as a use time and puts a tick on the chart at the hour
// somebody typed, which nothing on screen would contradict.

import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import {
  addSubstanceDailyTotalAction,
  updateSubstanceDailyTotalAction,
} from "@/app/(app)/medical/substance-use/actions";
import { actAs, createLogin, createProfile, fd } from "./harness";
import { setProfileSetting } from "@/lib/settings";
import { shiftDateStr } from "@/lib/date";
import { gatherHistoryLog } from "@/lib/history";
import {
  deleteFoodLogEventCore,
  updateFoodLogEventCore,
} from "@/lib/food-log-write";
import { getIntradayDay, getSubstanceDailyTotals } from "@/lib/queries";

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
function dayView(loginId: number, profileId: number, date: string) {
  const gather = gatherHistoryLog(profileId, {
    loginId,
    day: date,
    limit: 50,
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

  // THE WIDENING THIS LANE MUST NOT DO. `substance_daily_totals` has no column to hold
  // an instant, so a posted one is refused rather than half-kept: the day row must not
  // come back carrying a minute nobody could have stated.
  it.each(["nicotine", "cannabis", "Kratom"])(
    "refuses a posted time for %s, whose ledger is timeless",
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
      expect(getSubstanceDailyTotals(profile.id, substance)[0]).toMatchObject({
        date,
        amount: 2,
      });
      const { rows, ticks } = dayView(login.id, profile.id, date);
      const row = rows.find((r) => r.kind === "substance");
      // ONE DAY ROW, DATE-ONLY, AND ITS CORRECTION IS STILL THE DAY-COUNT FORM: these
      // ledgers have no events until phase 2. `recorded_at` IS populated on the row —
      // the read must not reach for it.
      expect(row).toMatchObject({ clock: null, sortTime: null });
      expect(row?.edit).toMatchObject({ kind: "substance", amount: 2 });
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

// THE ALCOHOL RECONCILIATION CONTRACT (#1078/#2009), asserted for the timed write in
// BOTH directions: the day counter equals the events that back it, and no correction
// leaves an event stranded on a day its row has left.
describe("events and the day total stay consistent through a timed correction", () => {
  it("shrinks, grows and re-dates without stranding an event or a stale count", async () => {
    const { profile } = seat("clock-reconcile");
    const date = shiftDateStr(today(profile.id), -4);
    const added = await addSubstanceDailyTotalAction(
      fd({
        substance: "alcohol",
        date,
        amount: "3",
        stated_at: `${date}T20:00:00Z`,
      })
    );
    if (added.kind !== "added") throw new Error("timed entry was not added");
    expect(taps(profile.id, date)).toHaveLength(3);
    expect(dayServings(profile.id, date)).toBe(3);

    // SHRINK: the surplus tap leaves through the row-delete core, and the counter
    // follows it down rather than being left to describe rows that are gone.
    await updateSubstanceDailyTotalAction(
      fd({ id: String(added.id), substance: "alcohol", date, amount: "1" })
    );
    expect(taps(profile.id, date)).toEqual([
      { occurred_at: `${date}T20:00:00Z`, time_source: "stated" },
    ]);
    expect(dayServings(profile.id, date)).toBe(1);

    // GROW: the appended unit is a real event, and the count is the events' count.
    await updateSubstanceDailyTotalAction(
      fd({ id: String(added.id), substance: "alcohol", date, amount: "3" })
    );
    expect(taps(profile.id, date)).toHaveLength(3);
    expect(dayServings(profile.id, date)).toBe(3);

    // RE-DATE: nobody restated an hour for the new day, so the stated instant is
    // cleared WITH the move — an instant from the old day is exactly the cross-day
    // pair the stated-time gate refuses to write anywhere else.
    const moved = shiftDateStr(date, 1);
    await updateSubstanceDailyTotalAction(
      fd({
        id: String(added.id),
        substance: "alcohol",
        date: moved,
        amount: "3",
      })
    );
    expect(taps(profile.id, date)).toEqual([]);
    expect(dayServings(profile.id, date)).toBe(0);
    expect(taps(profile.id, moved)).toEqual([
      { occurred_at: null, time_source: null },
      { occurred_at: null, time_source: null },
      { occurred_at: null, time_source: null },
    ]);
    expect(dayServings(profile.id, moved)).toBe(3);
  });
});
