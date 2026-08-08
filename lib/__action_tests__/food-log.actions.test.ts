// SERVER-ACTION TIER — food-group serving log write path (issue #579).
//
// Proves the real logFoodServing/undoFoodServing actions run through the (mocked) auth
// guard, keep ONE row per (profile, date, group) whose servings count increments/
// decrements, drop the row at zero, reject an unknown group, revalidate, and scope
// every write to the acting profile. The weekly rollup read reflects the writes.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db, today } from "@/lib/db";
import {
  logFoodServing,
  undoFoodServing,
  updateFoodLogEvent,
  trackFoodHabit,
  untrackFoodHabit,
} from "@/app/(app)/nutrition/actions";
import {
  getFoodMealDays,
  getFoodServingsOnDate,
  getFoodRollupInRange,
  getFrequencyTargets,
  rankFoodGroups,
} from "@/lib/queries";
import { createLogin, createProfile, actAs, fd } from "./harness";
import { getTimezone } from "@/lib/settings";
import { shiftDateStr, utcInstant, zonedWallTimeToUtc } from "@/lib/date";

const revalidate = vi.mocked(revalidatePath);
const DATE = "2026-07-08";

function rows(profileId: number) {
  return db
    .prepare(
      "SELECT date, group_key, servings FROM food_log WHERE profile_id = ? ORDER BY group_key"
    )
    .all(profileId) as { date: string; group_key: string; servings: number }[];
}

beforeEach(() => {
  revalidate.mockClear();
});

describe("logFoodServing", () => {
  it("increments a single (date, group) row on repeated taps", async () => {
    const login = createLogin();
    const profile = createProfile("logger", login.id);
    actAs(login, profile);

    await logFoodServing(fd({ group_key: "fatty_fish", date: DATE }));
    await logFoodServing(fd({ group_key: "fatty_fish", date: DATE }));

    const r = rows(profile.id);
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({
      group_key: "fatty_fish",
      servings: 2,
      date: DATE,
    });
    expect(getFoodServingsOnDate(profile.id, DATE).get("fatty_fish")).toBe(2);
    expect(revalidate).toHaveBeenCalledWith("/nutrition");
  });

  it("rejects an unknown food group", async () => {
    const login = createLogin();
    const profile = createProfile("bad-group", login.id);
    actAs(login, profile);

    const res = await logFoodServing(
      fd({ group_key: "not_a_group", date: DATE })
    );
    expect(res.ok).toBe(false);
    expect(rows(profile.id)).toEqual([]);
  });

  it("returns the authoritative daily total so the bar can reconcile (#748 item 2)", async () => {
    const login = createLogin();
    const profile = createProfile("reconciler", login.id);
    actAs(login, profile);

    const first = await logFoodServing(
      fd({ group_key: "berries", date: DATE })
    );
    expect(first).toEqual({ ok: true, servings: 1 });
    const second = await logFoodServing(
      fd({ group_key: "berries", date: DATE })
    );
    expect(second).toEqual({ ok: true, servings: 2 });
  });
});

// ── #2053: the web bar's eating-time statement ──────────────────────────────────
//
// The action takes the user's CHOICE ("now" / an absolute local hour) and resolves it
// server-side, so a tab open for an hour cannot stamp a stale "now" and no browser has
// to convert a profile-local hour. What is pinned here is the whole contract: a stated
// choice writes `time_source = 'stated'`, silence writes NULL, and an unusable choice
// costs the STATEMENT and never the serving.
describe("logFoodServing — eating-time statement (#2053)", () => {
  function events(profileId: number) {
    return db
      .prepare(
        `SELECT date, group_key, eaten_at, time_source FROM food_log_events
          WHERE profile_id = ? ORDER BY id`
      )
      .all(profileId) as {
      date: string;
      group_key: string;
      eaten_at: string | null;
      time_source: string | null;
    }[];
  }

  it("records no eating time when the user states none", async () => {
    const login = createLogin();
    const profile = createProfile("unstated", login.id);
    actAs(login, profile);

    await logFoodServing(fd({ group_key: "fatty_fish", date: DATE }));

    expect(events(profile.id)[0]).toMatchObject({
      eaten_at: null,
      time_source: null,
    });
  });

  it("`now` stamps the server's own clock as a STATED instant", async () => {
    const login = createLogin();
    const profile = createProfile("stated-now", login.id);
    actAs(login, profile);
    const date = today(profile.id);

    await logFoodServing(
      fd({ group_key: "fatty_fish", date, eaten_at: "now" })
    );

    const [event] = events(profile.id);
    expect(event.time_source).toBe("stated");
    // A real instant, close to now — the action resolved it rather than trusting a
    // client timestamp. 'stated', not 'tap': the web "+" declares no "I'm eating now"
    // contract of its own, so the SOURCE of the instant is the person who said so.
    expect(
      Math.abs(Date.now() - new Date(event.eaten_at!).getTime())
    ).toBeLessThan(60_000);
  });

  it("an absolute local hour resolves in the PROFILE's timezone", async () => {
    const login = createLogin();
    const profile = createProfile("stated-hour", login.id);
    actAs(login, profile);
    const date = today(profile.id);

    // Local midnight is always today-local and always already past, whatever hour CI
    // runs at — so it is an offered hour by construction.
    await logFoodServing(
      fd({ group_key: "fatty_fish", date, eaten_at: "00:00" })
    );

    const [event] = events(profile.id);
    expect(event.time_source).toBe("stated");
    // utcInstant, not toISOString: food_log_events.eaten_at stores the canonical
    // second-resolution UTC instant (#2205), so the expectation names the same writer
    // the action uses rather than a second serialization of it.
    expect(event.eaten_at).toBe(
      utcInstant(zonedWallTimeToUtc(getTimezone(profile.id), date, "00:00")!)
    );
  });

  it("an unparseable choice costs the statement, never the serving", async () => {
    const login = createLogin();
    const profile = createProfile("garbage-choice", login.id);
    actAs(login, profile);
    const date = today(profile.id);

    const res = await logFoodServing(
      fd({ group_key: "fatty_fish", date, eaten_at: "whenever" })
    );

    expect(res.ok).toBe(true);
    expect(events(profile.id)[0]).toMatchObject({
      eaten_at: null,
      time_source: null,
    });
  });

  it("refuses a statement that would sit outside the row's own day", async () => {
    const login = createLogin();
    const profile = createProfile("wrong-day", login.id);
    actAs(login, profile);
    // Backfilling YESTERDAY while stating "now" — the instant's profile-local date isn't
    // the day the serving lands on, and `eaten_at` is what the window derivation and the
    // cross-midnight re-date read, so a row carrying it would contradict itself.
    const date = shiftDateStr(today(profile.id), -1);

    const res = await logFoodServing(
      fd({ group_key: "fatty_fish", date, eaten_at: "now" })
    );

    expect(res.ok).toBe(true);
    expect(events(profile.id)[0]).toMatchObject({
      date,
      eaten_at: null,
      time_source: null,
    });
  });
});

// ── #2269: meal_slot is declaration-or-override, never an echo ──────────────────
//
// The log path used to store the tab's slot beside a stated time, minting the
// incoherent (Morning tab, 19:00) pair whose consumers then disagreed — tallies said
// Morning, ranking said 19:00. Decision 1: at log time a stated time WINS; the tab's
// declaration is stored only when it is the only fact there is. Enforced in
// logFoodServingCore, so the web action pinned here, the quick-log sheet and the
// offline replay all inherit it together.
describe("logFoodServing — a stated time wins over the tab (#2269)", () => {
  // Frozen so the stated hours are deterministic: 21:30 UTC — Evening under the
  // default 11:00/15:00 boundaries — with 19:00 already past and offerable.
  const NOW_ISO = "2026-07-08T21:30:00Z";
  let priorNow: string | undefined;
  beforeEach(() => {
    priorNow = process.env.ALLOS_TEST_NOW;
    process.env.ALLOS_TEST_NOW = NOW_ISO;
    return () => {
      if (priorNow == null) delete process.env.ALLOS_TEST_NOW;
      else process.env.ALLOS_TEST_NOW = priorNow;
    };
  });

  function events(profileId: number) {
    return db
      .prepare(
        `SELECT meal_slot, eaten_at, time_source FROM food_log_events
          WHERE profile_id = ? ORDER BY id`
      )
      .all(profileId) as {
      meal_slot: string | null;
      eaten_at: string | null;
      time_source: string | null;
    }[];
  }

  it("stores eaten_at and NO meal_slot when a time is stated from a disagreeing tab", async () => {
    const login = createLogin();
    const profile = createProfile("stated-wins", login.id);
    actAs(login, profile);
    const date = today(profile.id);

    // Standing in the MORNING tab, stating 19:00 — the pair the old path echoed.
    const res = await logFoodServing(
      fd({
        group_key: "berries",
        date,
        meal_slot: "Morning",
        eaten_at: "19:00",
      })
    );
    expect(res.ok).toBe(true);
    const [row] = events(profile.id);
    expect(row.meal_slot).toBeNull();
    expect(row.time_source).toBe("stated");
    expect(row.eaten_at).toBe(
      utcInstant(zonedWallTimeToUtc(getTimezone(profile.id), date, "19:00")!)
    );
    // The action's answer names the DERIVED placement, so the bar lands the serving
    // visibly in its section rather than under the tab.
    expect(res).toMatchObject({ mealSlot: "Evening", mealServings: 1 });
  });

  it("the reported pair's consumers now AGREE: tally and ranking both say Evening", async () => {
    const login = createLogin();
    const profile = createProfile("agree-eve", login.id);
    actAs(login, profile);
    const date = today(profile.id);

    // The reported pair, and its mirror image as a control: berries stated 19:00 from
    // the Morning tab, leafy greens stated 08:00 from the Evening tab. One serving
    // each, so overall frecency ties and the slot signal is what decides the order.
    await logFoodServing(
      fd({
        group_key: "berries",
        date,
        meal_slot: "Morning",
        eaten_at: "19:00",
      })
    );
    await logFoodServing(
      fd({
        group_key: "leafy_greens",
        date,
        meal_slot: "Evening",
        eaten_at: "08:00",
      })
    );

    // The section tally files each under its EATEN window (foodEventWindow derives
    // from the instant — there is no stored tab echo left to win tier 1)…
    const day = getFoodMealDays(profile.id, [date])[0];
    expect(day.slotCounts.Evening.berries).toBe(1);
    expect(day.slotCounts.Morning.berries).toBeUndefined();
    expect(day.slotCounts.Morning.leafy_greens).toBe(1);
    // …and the ranking's slot signal weights the same events at their eating minutes,
    // so the two consumers now name the SAME window for one serving. Before #2269 the
    // tally said the tab and the ranking said the clock.
    const evening = rankFoodGroups(profile.id, "Evening");
    const morning = rankFoodGroups(profile.id, "Morning");
    expect(evening.indexOf("berries")).toBeLessThan(
      evening.indexOf("leafy_greens")
    );
    expect(morning.indexOf("leafy_greens")).toBeLessThan(
      morning.indexOf("berries")
    );
  });

  it("an explicit `now` wins over a stale tab and files under now's window", async () => {
    const login = createLogin();
    const profile = createProfile("now-wins", login.id);
    actAs(login, profile);
    const date = today(profile.id);

    // The tab still says Morning; the user answered "now" (21:30 → Evening).
    const res = await logFoodServing(
      fd({ group_key: "berries", date, meal_slot: "Morning", eaten_at: "now" })
    );
    expect(res.ok).toBe(true);
    const [row] = events(profile.id);
    expect(row.meal_slot).toBeNull();
    expect(row.time_source).toBe("stated");
    expect(res).toMatchObject({ mealSlot: "Evening" });
  });

  it("with no statement the tab's declaration is the only fact, and stores as today", async () => {
    const login = createLogin();
    const profile = createProfile("backfill-keeps", login.id);
    actAs(login, profile);
    const date = today(profile.id);

    const res = await logFoodServing(
      fd({ group_key: "berries", date, meal_slot: "Morning" })
    );
    expect(res.ok).toBe(true);
    const [row] = events(profile.id);
    // Backfill keeps its meal: the declaration stores, exactly as before #2269.
    expect(row.meal_slot).toBe("Morning");
    expect(row.eaten_at).toBeNull();
    expect(res).toMatchObject({ mealSlot: "Morning", mealServings: 1 });
  });

  // #2296 — the ruling, on the online half. The web form sends the CHOICE and the
  // server resolves it, so no client clock can push a statement into the future here;
  // what CAN happen is a page that went stale across local midnight, whose "13:00"
  // resolves onto a day that is no longer the day it is logging to. Same silence,
  // same fix: the serving lands, and the answer names what was lost.
  it("keeps the serving AND reports a refused statement, instead of dropping it in silence", async () => {
    const login = createLogin();
    const profile = createProfile("stated-refused", login.id);
    actAs(login, profile);
    // The stale-page shape: logging to YESTERDAY while stating an hour of today.
    // 19:00 is past under the frozen 21:30 now, so it resolves to today — the row's
    // own day is yesterday, and the pair rule refuses it.
    const yesterday = shiftDateStr(today(profile.id), -1);

    const res = await logFoodServing(
      fd({ group_key: "berries", date: yesterday, eaten_at: "19:00" })
    );
    // The write SUCCEEDED — that posture is not negotiable, the serving is the thing
    // that must never be lost — and it carries the reason the minute did not land.
    expect(res).toMatchObject({ ok: true, statedTimeRefused: "other-day" });
    expect(events(profile.id)[0]).toMatchObject({
      eaten_at: null,
      time_source: null,
    });
  });

  it("says nothing when nobody stated a time — absence is not a refusal", async () => {
    // The distinction the whole change rests on. A plain "+" is the overwhelmingly
    // common tap; announcing a lost minute there would be noise about nothing.
    const login = createLogin();
    const profile = createProfile("stated-quiet", login.id);
    actAs(login, profile);
    const res = await logFoodServing(
      fd({ group_key: "berries", date: today(profile.id) })
    );
    expect(res.ok).toBe(true);
    expect(res).not.toHaveProperty("statedTimeRefused");
  });

  it("an UNUSABLE statement degrades to the declaration, not to nothing", async () => {
    const login = createLogin();
    const profile = createProfile("degrade-decl", login.id);
    actAs(login, profile);
    const date = today(profile.id);

    // The statement is refused (garbage), so no time is recorded — and the write is
    // then a declaration-only backfill, which keeps its tab.
    const res = await logFoodServing(
      fd({
        group_key: "berries",
        date,
        meal_slot: "Morning",
        eaten_at: "whenever",
      })
    );
    expect(res.ok).toBe(true);
    expect(events(profile.id)[0]).toMatchObject({
      meal_slot: "Morning",
      eaten_at: null,
    });
  });
});

// ── #2227: the correction sheet's eating-time wire ──────────────────────────────
//
// One more field on updateFoodLogEvent with three wire values: absent/empty leaves the
// row's eating time alone, "none" clears it, "HH:MM" states that wall time on the
// SUBMITTED day. The pin that matters most is the INVERTED judgeEatenAt posture: on
// the log path an unusable instant costs the statement and not the serving (which must
// land), but in a correction the statement IS the submission, so a refused instant is
// a formError the user sees — never a silent clear. Since #2296 the difference is what
// a refusal COSTS, not whether it is mentioned: both surfaces say it, one as a notice
// on a write that succeeded and one as the failure it genuinely is.
describe("updateFoodLogEvent — eating-time correction (#2227)", () => {
  function eventRow(profileId: number) {
    const rows = db
      .prepare(
        `SELECT id, date, group_key, meal_slot, logged_at, eaten_at, time_source
           FROM food_log_events WHERE profile_id = ? ORDER BY id`
      )
      .all(profileId) as {
      id: number;
      date: string;
      group_key: string;
      meal_slot: string | null;
      logged_at: string;
      eaten_at: string | null;
      time_source: string | null;
    }[];
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  // Fixtures sit on YESTERDAY so a stated noon is in the past whatever hour CI runs
  // at — the acceptance gate's future rule never bites the cases that aren't about it.
  it('"HH:MM" states the wall time of the submitted day', async () => {
    const login = createLogin();
    const profile = createProfile("time-stater", login.id);
    actAs(login, profile);
    const date = shiftDateStr(today(profile.id), -1);
    await logFoodServing(fd({ group_key: "berries", date }));
    const event = eventRow(profile.id);

    const res = await updateFoodLogEvent(
      fd({ event_id: event.id, date, eaten_at: "12:00" })
    );
    expect(res.ok).toBe(true);
    const after = eventRow(profile.id);
    expect(after.time_source).toBe("stated");
    // The same writer + resolver the log path uses — one serialization, one zone.
    expect(after.eaten_at).toBe(
      utcInstant(zonedWallTimeToUtc(getTimezone(profile.id), date, "12:00")!)
    );
    // The audit stamp is not the statement's to touch.
    expect(after.logged_at).toBe(event.logged_at);
  });

  it('"none" clears the statement back to "nobody said"', async () => {
    const login = createLogin();
    const profile = createProfile("time-clearer", login.id);
    actAs(login, profile);
    const date = shiftDateStr(today(profile.id), -1);
    await logFoodServing(fd({ group_key: "berries", date }));
    const event = eventRow(profile.id);
    await updateFoodLogEvent(
      fd({ event_id: event.id, date, eaten_at: "12:00" })
    );

    const res = await updateFoodLogEvent(
      fd({ event_id: event.id, date, eaten_at: "none" })
    );
    expect(res.ok).toBe(true);
    expect(eventRow(profile.id)).toMatchObject({
      eaten_at: null,
      time_source: null,
    });
  });

  it("an absent field leaves the stated time alone", async () => {
    const login = createLogin();
    const profile = createProfile("time-keeper", login.id);
    actAs(login, profile);
    const date = shiftDateStr(today(profile.id), -1);
    await logFoodServing(fd({ group_key: "berries", date }));
    const event = eventRow(profile.id);
    await updateFoodLogEvent(
      fd({ event_id: event.id, date, eaten_at: "12:00" })
    );
    const stated = eventRow(profile.id).eaten_at;

    // A meal-only correction says nothing about the time — and changes nothing.
    const res = await updateFoodLogEvent(
      fd({ event_id: event.id, date, meal_slot: "Evening" })
    );
    expect(res.ok).toBe(true);
    expect(eventRow(profile.id)).toMatchObject({
      meal_slot: "Evening",
      eaten_at: stated,
      time_source: "stated",
    });
  });

  it("a refused instant is a formError the user sees, never a silent clear", async () => {
    const login = createLogin();
    const profile = createProfile("time-refused", login.id);
    actAs(login, profile);
    const yesterday = shiftDateStr(today(profile.id), -1);
    await logFoodServing(fd({ group_key: "berries", date: yesterday }));
    const event = eventRow(profile.id);
    await updateFoodLogEvent(
      fd({ event_id: event.id, date: yesterday, eaten_at: "12:00" })
    );
    const before = eventRow(profile.id);

    // Tomorrow noon is meaningfully future by construction, whatever hour the suite
    // runs at — the acceptance gate refuses it, and the INVERTED posture surfaces
    // that refusal instead of dropping the statement the way the log path would.
    const res = await updateFoodLogEvent(
      fd({
        event_id: event.id,
        date: shiftDateStr(today(profile.id), 1),
        eaten_at: "12:00",
      })
    );
    // #2296: the refusal now names the rule that fired. This one is FUTURE, and the
    // old copy blamed the day for it — sending the user to correct a date that was
    // already exactly what they meant.
    expect(res).toEqual({ ok: false, error: "That time hasn't happened yet." });
    // NOTHING moved — not the day, and (the silent-clear hazard) not the statement.
    expect(eventRow(profile.id)).toEqual(before);

    // Garbage is refused as loudly, not coerced and not swallowed.
    const garbage = await updateFoodLogEvent(
      fd({ event_id: event.id, date: yesterday, eaten_at: "25:99" })
    );
    expect(garbage.ok).toBe(false);
    expect(eventRow(profile.id)).toEqual(before);
  });
});

describe("undoFoodServing", () => {
  it("decrements, then removes the row at zero", async () => {
    const login = createLogin();
    const profile = createProfile("undoer", login.id);
    actAs(login, profile);

    await logFoodServing(fd({ group_key: "legumes", date: DATE }));
    await logFoodServing(fd({ group_key: "legumes", date: DATE }));
    const afterUndo = await undoFoodServing(
      fd({ group_key: "legumes", date: DATE })
    );
    expect(afterUndo).toEqual({ ok: true, servings: 1 }); // remaining total
    expect(rows(profile.id)[0].servings).toBe(1);

    const atZero = await undoFoodServing(
      fd({ group_key: "legumes", date: DATE })
    );
    expect(atZero).toEqual({ ok: true, servings: 0 }); // row dropped → 0
    expect(rows(profile.id)).toEqual([]); // dropped at zero
  });
});

describe("food_log_events ledger through the actions (#950)", () => {
  function ledger(profileId: number) {
    return db
      .prepare(
        `SELECT group_key, date, logged_at, meal_slot FROM food_log_events
          WHERE profile_id = ? ORDER BY id`
      )
      .all(profileId) as {
      group_key: string;
      date: string;
      logged_at: string;
      meal_slot: string | null;
    }[];
  }

  it("logFoodServing appends a per-tap event alongside the counter", async () => {
    const login = createLogin();
    const profile = createProfile("event-logger", login.id);
    actAs(login, profile);

    await logFoodServing(fd({ group_key: "fatty_fish", date: DATE }));
    await logFoodServing(fd({ group_key: "fatty_fish", date: DATE }));

    const evs = ledger(profile.id);
    expect(evs).toHaveLength(2);
    expect(evs[0]).toMatchObject({ group_key: "fatty_fish", date: DATE });
    // logged_at is a real ISO instant (tap time), not the food date.
    expect(evs[0].logged_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("undoFoodServing pops the newest event", async () => {
    const login = createLogin();
    const profile = createProfile("event-undoer", login.id);
    actAs(login, profile);

    await logFoodServing(fd({ group_key: "berries", date: DATE }));
    await logFoodServing(fd({ group_key: "berries", date: DATE }));
    await undoFoodServing(fd({ group_key: "berries", date: DATE }));

    expect(ledger(profile.id)).toHaveLength(1);
  });

  it("persists and returns the selected meal slot for a backfill", async () => {
    const login = createLogin();
    const profile = createProfile("meal-backfiller", login.id);
    actAs(login, profile);

    const logged = await logFoodServing(
      fd({ group_key: "berries", date: DATE, meal_slot: "Morning" })
    );
    expect(logged).toEqual({
      ok: true,
      servings: 1,
      mealSlot: "Morning",
      mealServings: 1,
    });
    expect(ledger(profile.id)[0]).toMatchObject({
      group_key: "berries",
      date: DATE,
      meal_slot: "Morning",
    });

    const undone = await undoFoodServing(
      fd({ group_key: "berries", date: DATE, meal_slot: "Morning" })
    );
    expect(undone).toEqual({
      ok: true,
      servings: 0,
      mealSlot: "Morning",
      mealServings: 0,
    });
    expect(ledger(profile.id)).toEqual([]);
  });

  it("rejects a forged meal slot without writing", async () => {
    const login = createLogin();
    const profile = createProfile("bad-meal-slot", login.id);
    actAs(login, profile);

    const result = await logFoodServing(
      fd({ group_key: "berries", date: DATE, meal_slot: "Brunch" })
    );
    expect(result.ok).toBe(false);
    expect(rows(profile.id)).toEqual([]);
  });
});

describe("trackFoodHabit / untrackFoodHabit (#580)", () => {
  it("tracks a food group as a food_group frequency target, updating cadence on re-track", async () => {
    const login = createLogin();
    const profile = createProfile("habit-tracker", login.id);
    actAs(login, profile);

    await trackFoodHabit(fd({ group_key: "fatty_fish", per_week: 2 }));
    let targets = getFrequencyTargets(profile.id);
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({
      scope_kind: "food_group",
      scope_value: "fatty_fish",
      per_week: 2,
    });

    // Re-tracking updates the cadence rather than duplicating.
    await trackFoodHabit(fd({ group_key: "fatty_fish", per_week: 3 }));
    targets = getFrequencyTargets(profile.id);
    expect(targets).toHaveLength(1);
    expect(targets[0].per_week).toBe(3);
  });

  it("a double-tap can't create two targets for one group (#748 item 4)", async () => {
    const login = createLogin();
    const profile = createProfile("double-tapper", login.id);
    actAs(login, profile);

    // Two near-simultaneous "Track" posts (the FoodSuggestions button + the card form,
    // or a fat-fingered double tap). The partial unique index + upsert collapse them.
    await Promise.all([
      trackFoodHabit(fd({ group_key: "berries", per_week: 2 })),
      trackFoodHabit(fd({ group_key: "berries", per_week: 2 })),
    ]);
    const targets = getFrequencyTargets(profile.id).filter(
      (t) => t.scope_value === "berries"
    );
    expect(targets).toHaveLength(1);
  });

  it("untrack nulls a referencing protocol's link, then removes the target", async () => {
    const login = createLogin();
    const profile = createProfile("habit-untracker", login.id);
    actAs(login, profile);

    await trackFoodHabit(fd({ group_key: "legumes", per_week: 4 }));
    const target = getFrequencyTargets(profile.id)[0];
    // A protocol adopts it as its intervention.
    db.prepare(
      `INSERT INTO protocols
         (profile_id, name, start_date, outcome_keys, frequency_target_id, owns_frequency_target)
       VALUES (?, 'Legumes', '2026-05-01', '[]', ?, 1)`
    ).run(profile.id, target.id);

    await untrackFoodHabit(fd({ target_id: target.id }));

    expect(getFrequencyTargets(profile.id)).toEqual([]);
    const p = db
      .prepare("SELECT frequency_target_id FROM protocols WHERE profile_id = ?")
      .get(profile.id) as { frequency_target_id: number | null };
    expect(p.frequency_target_id).toBeNull();
  });
});

describe("canonicalizes the persisted slug, never storing the raw input (#883)", () => {
  it("logFoodServing stores the canonical slug for a case/punctuation variant", async () => {
    const login = createLogin();
    const profile = createProfile("canon-log", login.id);
    actAs(login, profile);

    // The matcher accepts these variants; the write must land the canonical slug so
    // downstream exact-match reads (daily totals, rollup, habit progress) can find it.
    await logFoodServing(fd({ group_key: "Leafy_Greens", date: DATE }));
    await logFoodServing(fd({ group_key: "leafy-greens", date: DATE }));

    const r = rows(profile.id);
    expect(r).toHaveLength(1); // one canonical row, not two raw variants
    expect(r[0]).toMatchObject({ group_key: "leafy_greens", servings: 2 });
    // The rollup (exact-match reader) sees the servings.
    expect(getFoodRollupInRange(profile.id, DATE, DATE)).toEqual([
      expect.objectContaining({ slug: "leafy_greens", servings: 2 }),
    ]);
  });

  it("undoFoodServing on a variant targets the canonical row a canonical log wrote", async () => {
    const login = createLogin();
    const profile = createProfile("canon-undo", login.id);
    actAs(login, profile);

    await logFoodServing(fd({ group_key: "leafy_greens", date: DATE }));
    const res = await undoFoodServing(
      fd({ group_key: "Leafy-Greens", date: DATE })
    );
    expect(res).toEqual({ ok: true, servings: 0 });
    expect(rows(profile.id)).toEqual([]);
  });

  it("trackFoodHabit stores the canonical scope_value for a variant", async () => {
    const login = createLogin();
    const profile = createProfile("canon-habit", login.id);
    actAs(login, profile);

    await trackFoodHabit(fd({ group_key: "Fatty-Fish", per_week: 2 }));
    const targets = getFrequencyTargets(profile.id);
    expect(targets).toHaveLength(1);
    expect(targets[0].scope_value).toBe("fatty_fish");
  });

  it("still rejects a truly unknown group without writing", async () => {
    const login = createLogin();
    const profile = createProfile("canon-reject", login.id);
    actAs(login, profile);

    const res = await logFoodServing(
      fd({ group_key: "definitely_not_a_group", date: DATE })
    );
    expect(res.ok).toBe(false);
    expect(rows(profile.id)).toEqual([]);
  });

  it("existing canonical slugs keep working unchanged", async () => {
    const login = createLogin();
    const profile = createProfile("canon-existing", login.id);
    actAs(login, profile);

    await logFoodServing(fd({ group_key: "berries", date: DATE }));
    expect(rows(profile.id)[0]).toMatchObject({
      group_key: "berries",
      servings: 1,
    });
  });
});

describe("scoping + rollup", () => {
  it("one profile's log never leaks into another's rollup", async () => {
    const login = createLogin();
    const a = createProfile("food-a", login.id);
    const b = createProfile("food-b", login.id);

    actAs(login, a);
    await logFoodServing(fd({ group_key: "fatty_fish", date: DATE }));

    const rollupA = getFoodRollupInRange(a.id, DATE, DATE);
    const rollupB = getFoodRollupInRange(b.id, DATE, DATE);
    expect(rollupA.map((g) => g.slug)).toEqual(["fatty_fish"]);
    expect(rollupB).toEqual([]);
  });
});
