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
});

describe("undoFoodServing", () => {
  it("decrements, then removes the row at zero", async () => {
    const login = createLogin();
    const profile = createProfile("undoer", login.id);
    actAs(login, profile);

    await logFoodServing(fd({ group_key: "legumes", date: DATE }));
    await logFoodServing(fd({ group_key: "legumes", date: DATE }));
    await undoFoodServing(fd({ group_key: "legumes", date: DATE }));
    expect(rows(profile.id)[0].servings).toBe(1);

    await undoFoodServing(fd({ group_key: "legumes", date: DATE }));
    expect(rows(profile.id)).toEqual([]); // dropped at zero
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
