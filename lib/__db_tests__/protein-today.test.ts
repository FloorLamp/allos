// DB INTEGRATION TIER — the #974 protein band-gauge gather (getProteinToday) over a seeded
// day: today's food-group servings + a quick-add + (in one case) a tracked reading. Pins
// the #221 invariants: the gauge's weekly marker EQUALS the adequacy computation's daily
// average, and the gauge's today logged component uses the SAME read as the quick-add card.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  getProteinToday,
  getProteinAdequacy,
  getProteinLoggedGrams,
} from "@/lib/queries";
import { addProteinGramsCore } from "@/lib/protein-log-write";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
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
function seedTrackedProtein(profileId: number, date: string, grams: number) {
  db.prepare(
    `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
     VALUES (?, 'health_connect', 'protein_g', ?, ?, ?, ?)`
  ).run(profileId, date, `${date}T08:00:00Z`, `${date}T08:00:00Z`, grams);
}

describe("getProteinToday (#974)", () => {
  it("composes today's estimated + quick-add grams and exposes the goal band", () => {
    const p = newProfile("today-combined");
    const anchor = today(p);
    seedWeight(p, anchor, 80); // active target ~95–130 g
    logFood(p, anchor, "poultry", 1); // 35 estimated
    addProteinGramsCore(p, anchor, 30); // quick-add 30

    const t = getProteinToday(p);
    expect(t).not.toBeNull();
    expect(Math.round(t!.todayGrams)).toBe(65); // 35 + 30
    expect(t!.todayIntake?.basis).toBe("combined");
    expect(t!.target.gramsLow).toBe(95);
    expect(t!.target.gramsHigh).toBe(130);
  });

  it("#221 pin: the weekly marker EQUALS the adequacy computation's daily average", () => {
    const p = newProfile("today-pin-weekly");
    const anchor = today(p);
    seedWeight(p, anchor, 80);
    logFood(p, anchor, "poultry", 1);
    logFood(p, anchor, "eggs", 1);

    const gauge = getProteinToday(p);
    const adequacy = getProteinAdequacy(p);
    expect(gauge?.weeklyAverageGrams).not.toBeNull();
    expect(gauge?.weeklyAverageGrams).toBe(adequacy?.intake.grams);
    // …and the band is the same one the adequacy card shows.
    expect(gauge?.target.gramsLow).toBe(adequacy?.target.gramsLow);
    expect(gauge?.target.gramsHigh).toBe(adequacy?.target.gramsHigh);
  });

  it("#221 pin: today's logged component is the SAME read as the quick-add card total", () => {
    const p = newProfile("today-pin-logged");
    const anchor = today(p);
    seedWeight(p, anchor, 80);
    addProteinGramsCore(p, anchor, 42);

    const gauge = getProteinToday(p);
    // The quick-add card renders getProteinLoggedGrams(today); the gauge's logged
    // component reads the same source — they can never drift.
    expect(gauge?.todayIntake?.loggedGrams).toBe(
      getProteinLoggedGrams(p, anchor)
    );
    // With no food logged, the gauge today figure IS the quick-add total.
    expect(Math.round(gauge!.todayGrams)).toBe(
      getProteinLoggedGrams(p, anchor)
    );
  });

  it("a tracked reading today overrides and labels the basis tracked", () => {
    const p = newProfile("today-tracked");
    const anchor = today(p);
    seedWeight(p, anchor, 80);
    logFood(p, anchor, "poultry", 1);
    seedTrackedProtein(p, anchor, 140);

    const t = getProteinToday(p);
    expect(t?.todayIntake?.basis).toBe("tracked");
    expect(Math.round(t!.todayGrams)).toBe(140);
  });

  it("null without a bodyweight target", () => {
    const p = newProfile("today-noweight");
    const anchor = today(p);
    logFood(p, anchor, "poultry", 1);
    expect(getProteinToday(p)).toBeNull();
  });

  it("null when there's a target but no protein data at all (no bare 0 g gauge)", () => {
    const p = newProfile("today-nodata");
    const anchor = today(p);
    seedWeight(p, anchor, 80);
    expect(getProteinToday(p)).toBeNull();
  });
});
