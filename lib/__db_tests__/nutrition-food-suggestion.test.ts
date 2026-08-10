// DB INTEGRATION TIER — a missed protein/fibre target becomes ONE curated food offer on
// the morning digest (issue #2383), end to end from seeded food logs.
//
// What only this tier can prove: that the offer is assembled from the profile's REAL
// safety facts (recorded allergies, the active stack, coded conditions, dietary
// preferences) through the shared `getIntakeSafetyContext` gather, that it rides the
// rendered digest rather than merely existing, and that each of the three silences is a
// silence against the actual schema rather than against a fixture. The decision, the
// wording and the ranking are pinned in lib/__tests__/nutrition-food-suggestion.test.ts
// and are not re-asserted here.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import {
  setExcludedFoodGroups,
  setUserSex,
} from "@/lib/settings/profile-attrs";
import { getNutritionDay, getShortfallFoodSuggestion } from "@/lib/queries";
import { nutritionShortfalls } from "@/lib/nutrition-day";
import { gatherDigestNutrition } from "@/lib/notifications/digest-data";
import { formatMessageLine } from "@/lib/notifications/message-line";

function newProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, "UTC");
  setUserSex(id, "male"); // fibre DRI adequate intake 38 g/day
  return id;
}

function seedWeight(profileId: number, date: string, kg: number) {
  db.prepare(
    "INSERT INTO body_metrics (profile_id, date, weight_kg) VALUES (?, ?, ?)"
  ).run(profileId, date, kg);
}

function logFood(
  profileId: number,
  date: string,
  slug: string,
  servings: number
) {
  db.prepare(
    "INSERT INTO food_log (profile_id, date, group_key, servings) VALUES (?, ?, ?, ?)"
  ).run(profileId, date, slug, servings);
}

function seedTracked(
  profileId: number,
  metric: "protein_g" | "fiber_g",
  date: string,
  grams: number
) {
  db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'health_connect', ?, ?, ?, ?, ?)`
  ).run(
    profileId,
    metric,
    date,
    `${date}T08:00:00Z`,
    `${date}T08:00:00Z`,
    grams
  );
}

function seedAllergy(profileId: number, substance: string) {
  db.prepare(
    "INSERT INTO allergies (profile_id, substance, status) VALUES (?, ?, 'active')"
  ).run(profileId, substance);
}

function seedCondition(profileId: number, name: string) {
  db.prepare(
    "INSERT INTO conditions (profile_id, name, status) VALUES (?, ?, 'active')"
  ).run(profileId, name);
}

// A day whose logged eating leaves BOTH nutrients short of a resolved target: one poultry
// serving is 35 g protein against a 95 g floor, and it carries no fibre at all, so a
// single legume serving gives fibre a number to be short against.
function shortDay(name: string): { profileId: number; date: string } {
  const profileId = newProfile(name);
  const date = shiftDateStr(today(profileId), -1);
  seedWeight(profileId, date, 80); // active band 95–130 g
  logFood(profileId, date, "poultry", 1);
  logFood(profileId, date, "legumes", 1);
  return { profileId, date };
}

function offerFor(profileId: number, date: string) {
  return getShortfallFoodSuggestion(
    profileId,
    nutritionShortfalls(getNutritionDay(profileId, date))
  );
}

describe("getShortfallFoodSuggestion — the curated offer over real profile state", () => {
  it("answers a day short on both nutrients with ONE group the food bar can log", () => {
    const { profileId, date } = shortDay("shortfall-food-basic");
    const offer = offerFor(profileId, date);
    // 30 g short of 38 g fibre outranks 51 g short of 95 g protein: the miss is bigger as
    // a share of its own target, which is the only comparison the two share.
    expect(offer).toMatchObject({
      nutrient: "fiber",
      foodGroup: "legumes",
      groupName: "Legumes & beans",
      gramsPerServing: 8,
    });
    // The slug is a real catalog group — the same vocabulary the one-tap bar writes into
    // food_log.group_key, which is what makes the suggestion one tap from being acted on.
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM food_log WHERE profile_id = ? AND group_key = ?"
        )
        .get(profileId, offer!.foodGroup)
    ).toMatchObject({ n: 1 });
  });

  it("surfaces the curated ALTERNATIVE when recorded allergies strike the primaries", () => {
    const { profileId, date } = shortDay("shortfall-food-allergy");
    // Leave fibre satisfied so the protein entry (the one with an alternative) answers.
    seedTracked(profileId, "fiber_g", date, 40);
    for (const s of ["Fish", "Egg", "Poultry", "Tofu"])
      seedAllergy(profileId, s);

    const offer = offerFor(profileId, date);
    expect(offer).toMatchObject({
      nutrient: "protein",
      foodGroup: "whole_grains",
      isAlternative: true,
    });
  });

  it("withholds it entirely for a recorded drop-severity condition", () => {
    const { profileId, date } = shortDay("shortfall-food-ckd");
    seedTracked(profileId, "fiber_g", date, 40); // fibre fine; protein is the question
    seedCondition(profileId, "Chronic kidney disease, stage 3");
    // Raising protein with reduced kidney function is clinician territory — the app says
    // nothing rather than something dangerous. Absence is never an all-clear.
    expect(offerFor(profileId, date)).toBeNull();
  });

  it("substitutes around a dietary preference without losing the shortfall", () => {
    const { profileId, date } = shortDay("shortfall-food-preference");
    setExcludedFoodGroups(profileId, ["legumes"]);
    const offer = offerFor(profileId, date);
    expect(offer?.foodGroup).toBe("berries");
    // The gap itself is untouched — a preference filters the answer, never the question.
    expect(nutritionShortfalls(getNutritionDay(profileId, date)).length).toBe(
      2
    );
  });
});

describe("the three ways it yields nothing, against the real schema", () => {
  it("MET TARGET — a day that reached both targets offers nothing", () => {
    const profileId = newProfile("shortfall-food-met");
    const date = shiftDateStr(today(profileId), -1);
    seedWeight(profileId, date, 80);
    seedTracked(profileId, "protein_g", date, 110); // within 95–130
    seedTracked(profileId, "fiber_g", date, 40); // within 38–61
    expect(nutritionShortfalls(getNutritionDay(profileId, date))).toEqual([]);
    expect(offerFor(profileId, date)).toBeNull();
  });

  it("UNRESOLVED TARGET — no bodyweight on record means no protein offer", () => {
    const profileId = newProfile("shortfall-food-no-target");
    const date = shiftDateStr(today(profileId), -1);
    // Protein is logged but nothing scales its band, and the fibre logged is enough.
    logFood(profileId, date, "poultry", 1);
    seedTracked(profileId, "fiber_g", date, 40);
    expect(getNutritionDay(profileId, date)?.protein).toBeNull();
    expect(offerFor(profileId, date)).toBeNull();
  });

  it("NO LOGS — an unlogged day offers nothing, because it is not a day of zero", () => {
    const profileId = newProfile("shortfall-food-unlogged");
    const date = shiftDateStr(today(profileId), -1);
    seedWeight(profileId, date, 80); // a target resolves; there is simply no eating
    expect(getNutritionDay(profileId, date)).toBeNull();
    expect(offerFor(profileId, date)).toBeNull();
  });
});

describe("the digest line it rides", () => {
  it("appends the offer as the last note, after the figures", () => {
    const { profileId, date } = shortDay("shortfall-food-digest");
    const { line } = gatherDigestNutrition(profileId, date);
    expect(line?.head).toBe("Nutrition");
    expect(line?.notes).toHaveLength(3);
    expect(formatMessageLine(line!)).toBe(
      "Nutrition — protein 44 g+ of 95 g · fiber 8 g+ of 38 g · try legumes & beans (8 g fiber a serving)"
    );
  });

  it("leaves the line at its figures when the screens withhold the offer", () => {
    const { profileId, date } = shortDay("shortfall-food-digest-withheld");
    // Protein is DROPPED by the CKD contraindication; fibre survives but carries a
    // condition caution this one-line surface has no room to print, so it is not
    // compressed either — the caveat is never the thing that gets dropped.
    seedCondition(profileId, "Chronic kidney disease");
    seedCondition(profileId, "Gastroparesis");
    const { line } = gatherDigestNutrition(profileId, date);
    // Still a complete line: reporting a gap and offering nothing is the pre-#2383
    // behaviour, and it is the correct fallback rather than a failure.
    expect(line?.notes).toHaveLength(2);
    expect(formatMessageLine(line!)).toBe(
      "Nutrition — protein 44 g+ of 95 g · fiber 8 g+ of 38 g"
    );
  });

  it("gathers no offer at all for a reader who turned the category down", () => {
    const { profileId, date } = shortDay("shortfall-food-demoted");
    const demoted = gatherDigestNutrition(profileId, date, ["nutrition"]);
    // The shortfall is still collected (the Tune keyboard has to keep offering the
    // toggle), but there is no line and therefore nothing to attach an offer to.
    expect(demoted.shortfalls.length).toBeGreaterThan(0);
    expect(demoted.line).toBeNull();
  });
});
