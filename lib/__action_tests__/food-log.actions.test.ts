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
  trackFoodHabit,
  untrackFoodHabit,
} from "@/app/(app)/nutrition/actions";
import {
  getFoodServingsOnDate,
  getFoodRollupInRange,
  getFrequencyTargets,
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
