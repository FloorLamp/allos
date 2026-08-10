// DB INTEGRATION TIER — the #2379 per-day nutrition gather (`getNutritionDay`) over a
// seeded calendar day, and the digest's use of it (`gatherDigestNutrition`).
//
// The gather is what only this tier can prove: that the day is scoped to ONE date, that
// protein's target is resolved as of that day rather than from a later weigh-in, and that
// each silence — no logs, no bodyweight — really is silence against the real schema
// rather than a zero. The decision and the phrasing are pinned in
// lib/__tests__/nutrition-day.test.ts and are not re-asserted here.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { setUserSex } from "@/lib/settings/profile-attrs";
import { getNutritionDay } from "@/lib/queries";
import { nutritionShortfalls } from "@/lib/nutrition-day";
import { gatherDigestNutrition } from "@/lib/notifications/digest-data";

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

describe("getNutritionDay (#2379)", () => {
  it("positions both nutrients on the SELECTED day, ignoring the days around it", () => {
    const p = newProfile("nutrition-day-scoped");
    const anchor = today(p);
    const yesterday = shiftDateStr(anchor, -1);
    seedWeight(p, yesterday, 80); // active band 95–130 g
    logFood(p, yesterday, "poultry", 1); // 35 g protein
    logFood(p, yesterday, "legumes", 1); // +9 g protein, 8 g fibre
    // Today's eating must not leak backwards into yesterday's position.
    logFood(p, anchor, "poultry", 4);

    const pos = getNutritionDay(p, yesterday);
    expect(pos?.date).toBe(yesterday);
    expect(Math.round(pos!.protein!.grams)).toBe(44);
    expect(pos?.protein?.targetGrams).toBe(95);
    expect(Math.round(pos!.fiber!.grams)).toBe(8);
    expect(pos?.fiber?.targetGrams).toBe(38);
    expect(nutritionShortfalls(pos).map((s) => s.shortfallGrams)).toEqual([
      51, 30,
    ]);
  });

  it("resolves protein's target as of that day, not from a later weigh-in", () => {
    const p = newProfile("nutrition-day-weight-asof");
    const anchor = today(p);
    const yesterday = shiftDateStr(anchor, -1);
    seedWeight(p, shiftDateStr(anchor, -10), 70); // 84–112, rounds to 85–110
    seedWeight(p, anchor, 100); // a weigh-in AFTER the day being reported
    logFood(p, yesterday, "poultry", 1);

    // The band comes from the 70 kg on record then, never today's 100 kg.
    expect(getNutritionDay(p, yesterday)?.protein?.targetGrams).toBe(85);
  });

  it("says nothing about a day with no food logged — absence is not a shortfall", () => {
    const p = newProfile("nutrition-day-unlogged");
    const anchor = today(p);
    const yesterday = shiftDateStr(anchor, -1);
    seedWeight(p, yesterday, 80);

    expect(getNutritionDay(p, yesterday)).toBeNull();
  });

  it("omits protein when no bodyweight resolves its target, and keeps fibre", () => {
    const p = newProfile("nutrition-day-no-weight");
    const anchor = today(p);
    const yesterday = shiftDateStr(anchor, -1);
    logFood(p, yesterday, "legumes", 1);

    const pos = getNutritionDay(p, yesterday);
    expect(pos?.protein).toBeNull();
    expect(Math.round(pos!.fiber!.grams)).toBe(8);
  });

  it("marks a tracked full-day total as measured rather than a floor", () => {
    const p = newProfile("nutrition-day-tracked");
    const anchor = today(p);
    const yesterday = shiftDateStr(anchor, -1);
    seedWeight(p, yesterday, 80);
    seedTracked(p, "protein_g", yesterday, 60);
    seedTracked(p, "fiber_g", yesterday, 12);

    const pos = getNutritionDay(p, yesterday);
    expect(pos?.protein?.isFloor).toBe(false);
    expect(pos?.fiber?.isFloor).toBe(false);
  });
});

describe("gatherDigestNutrition — the digest's use of it", () => {
  it("reports yesterday's shortfalls, and nothing on a day that met its targets", () => {
    const p = newProfile("digest-nutrition-shortfall");
    const anchor = today(p);
    const yesterday = shiftDateStr(anchor, -1);
    seedWeight(p, yesterday, 80);
    logFood(p, yesterday, "poultry", 1); // protein only — carries no fibre
    logFood(p, yesterday, "legumes", 1); // so fibre has a number to state

    const short = gatherDigestNutrition(p, yesterday);
    expect(short.shortfalls.map((s) => s.nutrient)).toEqual([
      "protein",
      "fiber",
    ]);
    // The gather hands the digest the line's PARTS (#2391): one note per short nutrient,
    // under the section noun. Nothing here assembles text.
    expect(short.line?.head).toBe("Nutrition");
    expect(short.line?.notes?.slice(0, 2)).toEqual([
      "protein 44 g+ of 95 g",
      "fiber 8 g+ of 38 g",
    ]);
    // Any note after those is the #2383 curated food offer, which is pinned in
    // lib/__db_tests__/nutrition-food-suggestion.test.ts. This test owns the figures.

    const met = newProfile("digest-nutrition-met");
    const metYesterday = shiftDateStr(today(met), -1);
    seedWeight(met, metYesterday, 80);
    seedTracked(met, "protein_g", metYesterday, 110); // within 95–130
    seedTracked(met, "fiber_g", metYesterday, 40); // within 38–61
    const quiet = gatherDigestNutrition(met, metYesterday);
    expect(quiet.shortfalls).toEqual([]);
    expect(quiet.line).toBeNull();
  });

  it("a demoted category turns down a floor shortfall but keeps a measured one", () => {
    const floor = newProfile("digest-nutrition-demoted-floor");
    const floorYesterday = shiftDateStr(today(floor), -1);
    seedWeight(floor, floorYesterday, 80);
    logFood(floor, floorYesterday, "poultry", 1); // estimated basis → a floor
    // The shortfall is still COLLECTED — the Tune keyboard has to keep offering the
    // toggle — but the demoted message carries no line for it.
    const demotedFloor = gatherDigestNutrition(floor, floorYesterday, [
      "nutrition",
    ]);
    expect(demotedFloor.shortfalls.length).toBeGreaterThan(0);
    expect(demotedFloor.line).toBeNull();

    const measured = newProfile("digest-nutrition-demoted-measured");
    const measuredYesterday = shiftDateStr(today(measured), -1);
    seedWeight(measured, measuredYesterday, 80);
    seedTracked(measured, "protein_g", measuredYesterday, 60);
    expect(
      gatherDigestNutrition(measured, measuredYesterday, ["nutrition"]).line
    ).not.toBeNull();
  });
});
