// SERVER-ACTION TIER — food-group serving log write path (issue #579).
//
// Proves the real logFoodServing/undoFoodServing actions run through the (mocked) auth
// guard, keep ONE row per (profile, date, group) whose servings count increments/
// decrements, drop the row at zero, reject an unknown group, revalidate, and scope
// every write to the acting profile. The weekly rollup read reflects the writes.

import { describe, it, expect, beforeEach, vi } from "vitest";
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
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
        `SELECT group_key, date, logged_at FROM food_log_events
          WHERE profile_id = ? ORDER BY id`
      )
      .all(profileId) as {
      group_key: string;
      date: string;
      logged_at: string;
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
