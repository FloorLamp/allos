// SERVER-ACTION TIER — the dietary-preferences write path (issue #975) through the real
// saveDietaryPreferences action + the (mocked) auth guard. Proves the profile-tier
// excluded-group set round-trips, normalizes to canonical slugs (dropping junk), clears
// back to Omnivore on an empty set, and revalidates the nutrition surface. Also proves the
// suggestion gather respects the stored set (a vegetarian's iron leads with legumes).

import { describe, it, expect, beforeEach, vi } from "vitest";

import { revalidatePath } from "next/cache";
import { saveDietaryPreferences } from "@/app/(app)/settings/profile/actions";
import { getExcludedFoodGroups } from "@/lib/settings";
import { getFoodSuggestions } from "@/lib/queries";
import { db } from "@/lib/db";
import { createLogin, createProfile, actAs } from "./harness";

const revalidate = vi.mocked(revalidatePath);

// FormData with a multi-value "excluded" field (the checkbox multi-select posts one
// value per checked group).
function excludedForm(slugs: string[]): FormData {
  const form = new FormData();
  for (const s of slugs) form.append("excluded", s);
  return form;
}

beforeEach(() => {
  revalidate.mockClear();
});

describe("saveDietaryPreferences", () => {
  it("round-trips the excluded set (canonical, sorted) and revalidates", async () => {
    const login = createLogin();
    const profile = createProfile("diet-pref", login.id);
    actAs(login, profile);

    expect(getExcludedFoodGroups(profile.id)).toEqual([]); // Omnivore by default

    await saveDietaryPreferences(excludedForm(["dairy", "eggs"]));
    expect(getExcludedFoodGroups(profile.id)).toEqual(["dairy", "eggs"]);
    expect(revalidate).toHaveBeenCalledWith("/nutrition");
  });

  it("drops unknown slugs (a forged post can't store junk)", async () => {
    const login = createLogin();
    const profile = createProfile("diet-junk", login.id);
    actAs(login, profile);

    await saveDietaryPreferences(
      excludedForm(["dairy", "not_a_group", "eggs"])
    );
    expect(getExcludedFoodGroups(profile.id)).toEqual(["dairy", "eggs"]);
  });

  it("an empty set clears back to Omnivore", async () => {
    const login = createLogin();
    const profile = createProfile("diet-clear", login.id);
    actAs(login, profile);

    await saveDietaryPreferences(excludedForm(["dairy"]));
    expect(getExcludedFoodGroups(profile.id)).toEqual(["dairy"]);
    await saveDietaryPreferences(excludedForm([]));
    expect(getExcludedFoodGroups(profile.id)).toEqual([]);
  });

  it("the suggestion gather respects the stored set (vegetarian iron → legumes)", async () => {
    const login = createLogin();
    const profile = createProfile("diet-suggest", login.id);
    actAs(login, profile);

    // A current low-iron reading so the #577 engine fires.
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, unit, canonical_name, flag, created_at)
       VALUES (?, date('now'), 'lab', 'Ferritin', '8', 'ng/mL', 'Ferritin', 'low', datetime('now'))`
    ).run(profile.id);

    // Vegetarian preset excludes the animal iron source.
    await saveDietaryPreferences(
      excludedForm([
        "fatty_fish",
        "lean_fish",
        "shellfish",
        "poultry",
        "red_meat",
        "processed_meat",
      ])
    );

    const iron = getFoodSuggestions(profile.id).find((s) => s.key === "iron");
    expect(iron).toBeTruthy();
    const groups = iron!.foods.map((f) => f.foodGroup);
    expect(groups).toContain("legumes");
    expect(groups).not.toContain("red_meat");
  });
});
