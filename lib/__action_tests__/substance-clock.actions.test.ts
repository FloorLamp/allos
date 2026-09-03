// A DRINK ON THE CLOCK (#3295 phase 1, parts 1 and 2), end to end: the form's stated
// minute through the action's gate, onto every unit of the entry as `occurred_at`, back
// out through the record's substance row, and onto the day chart as a `substance` tick.
//
// THE NEGATIVE CASE IS THE POINT OF THIS FILE. `substance_daily_totals` is UNIQUE per
// (profile, date, substance) and declares no event column, so nicotine, cannabis and
// custom substances have no minute to claim — but they DO carry `recorded_at`, which is
// what `bestKnownInstant` would answer with. A permissive read there prints a FILING
// stamp as a use time and puts a tick on the chart at the hour somebody typed, which
// nothing on screen would contradict. Every assertion below has that arm.

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
    ["an instant on another day", (d: string) => `${shiftDateStr(d, -1)}T21:30:00Z`],
    ["a far-future instant", () => "2099-01-01T21:30:00Z"],
    ["an unreadable instant", () => "not-an-instant"],
  ])("drops %s and still records the drink", async (_label, build) => {
    const { profile } = seat(`clock-refuse-${_label.slice(0, 8)}`);
    const date = shiftDateStr(today(profile.id), -1);
    expect(
      (
        await addSubstanceDailyTotalAction(
          fd({ substance: "alcohol", date, amount: "1", stated_at: build(date) })
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
        statedAt: null,
      });
      const { rows, ticks } = dayView(login.id, profile.id, date);
      const row = rows.find((r) => r.kind === "substance");
      // `recorded_at` IS populated on that row — the read must not reach for it.
      expect(row?.clock).toBeNull();
      expect(ticks).toEqual([]);
    }
  );
});

describe("the record reports the drink's instant (#3295 part 2)", () => {
  it("gives a timed drink a stated clock and a substance tick at that minute", async () => {
    const { login, profile } = seat("clock-read");
    const date = shiftDateStr(today(profile.id), -1);
    await addSubstanceDailyTotalAction(
      fd({
        substance: "alcohol",
        date,
        amount: "2",
        stated_at: `${date}T21:30:00Z`,
      })
    );

    const { rows, ticks } = dayView(login.id, profile.id, date);
    const row = rows.find((r) => r.kind === "substance");
    expect(row).toMatchObject({
      id: expect.stringContaining("substance:alcohol:"),
      // BARE, not "logged 21:30" — the grammar's whole distinction between a stated
      // time and a filing stamp (this seat's login keeps the 24-hour default).
      clock: "21:30",
      clockKind: "stated",
      sortTime: "21:30",
    });

    // ONE TICK, AT THE STATED MINUTE, AS A SUBSTANCE. The category is asserted rather
    // than assumed: a drink re-routed through the food rows would arrive as `food` and
    // read as a meal on the chart.
    expect(ticks).toEqual([
      expect.objectContaining({
        category: "substance",
        minute: 21 * 60 + 30,
        label: "Alcohol",
        eventId: row!.id,
      }),
    ]);
  });

  it("keeps the day row date-only when nobody stated a time", async () => {
    const { login, profile } = seat("clock-untimed");
    const date = shiftDateStr(today(profile.id), -1);
    await addSubstanceDailyTotalAction(
      fd({ substance: "alcohol", date, amount: "1" })
    );
    const { rows, ticks } = dayView(login.id, profile.id, date);
    expect(rows.find((r) => r.kind === "substance")).toMatchObject({
      clock: null,
      sortTime: null,
    });
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
      fd({ id: String(added.id), substance: "alcohol", date: moved, amount: "3" })
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
