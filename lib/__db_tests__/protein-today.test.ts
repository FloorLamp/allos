// DB INTEGRATION TIER — the #974 protein band-gauge gather (getProteinToday) over a seeded
// day: today's food-group servings + a quick-add + (in one case) a tracked reading. Pins
// the #221 invariants: the gauge's weekly marker EQUALS the adequacy computation's daily
// average, and the gauge's today logged component uses the SAME read as the quick-add card.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  getProteinOnDate,
  getProteinToday,
  getProteinAdequacy,
  getProteinLoggedGrams,
} from "@/lib/queries";
import { addProteinGramsCore } from "@/lib/protein-log-write";
import { shiftDateStr } from "@/lib/date";

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
// Quick-add grams, ASSERTING the write actually landed (#2327). addProteinGramsCore
// is a typed-outcome core: an amount over its per-add cap (MAX_GRAMS_PER_ADD) is
// REFUSED and returns { kind: "invalid" } having written nothing. A fixture that
// drops that outcome seeds a day it believes has protein and the reader honestly
// reports none — which is exactly how an over-cap 500 g here became a null gauge,
// and only on the profile's week-start day, where no week-to-date average was left
// to mask it. Every seeded add in this file goes through here, so a refused write
// fails loudly at the fixture instead of days later at an unrelated assertion.
function addProtein(profileId: number, date: string, grams: number) {
  expect(addProteinGramsCore(profileId, date, grams).kind).toBe("logged");
}

describe("getProteinToday (#974)", () => {
  it("reads a selected historical day's protein without leaking today's intake", () => {
    const p = newProfile("protein-on-date");
    const anchor = today(p);
    const yesterday = shiftDateStr(anchor, -1);
    seedWeight(p, yesterday, 80);
    logFood(p, yesterday, "poultry", 1); // 35 estimated
    addProtein(p, yesterday, 15); // +15 logged
    logFood(p, anchor, "eggs", 3); // must not enter yesterday

    const day = getProteinOnDate(p, yesterday);
    expect(Math.round(day!.todayGrams)).toBe(50);
    expect(day?.todayIntake?.basis).toBe("combined");
    expect(day?.weeklyAverageGrams).toBeNull();
  });

  it("composes today's estimated + quick-add grams and exposes the goal band", () => {
    const p = newProfile("today-combined");
    const anchor = today(p);
    seedWeight(p, anchor, 80); // active target ~95–130 g
    logFood(p, anchor, "poultry", 1); // 35 estimated
    addProtein(p, anchor, 30); // quick-add 30

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
    addProtein(p, anchor, 42);

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

  // ── The trailing 7-day average (#1917) ────────────────────────────────────────
  // The gather's job here is ASSEMBLY: per-day parts out of food_log, protein_log
  // and metric_samples, handed to the pure computation. These pin the seam — the
  // window's shape is pinned in lib/__tests__/protein-trailing.test.ts.

  it("the trailing average covers seven days, unlike the week-to-date figure", () => {
    const p = newProfile("trailing-seven-days");
    const anchor = today(p);
    seedWeight(p, anchor, 80);
    // Every complete day in the window carries the same 100 g, so the trailing
    // figure is 100 wherever the profile's week boundary happens to fall…
    for (let ago = 1; ago <= 7; ago++) {
      addProtein(p, shiftDateStr(anchor, -ago), 100);
    }
    // …while today is deliberately far off, which is what the old week-to-date
    // number carried into a line labelled "7-day average".
    addProtein(p, anchor, 300);

    const t = getProteinToday(p);
    expect(t!.trailing.grams).toBe(100);
    expect(t!.trailing.dayOne).toBe(false);
    // The week-to-date figure still exists, still includes today, and is still what
    // the weekly adequacy verdict is reached on — a different question, kept.
    expect(t!.weeklyAverageGrams).toBe(getProteinAdequacy(p)!.intake.grams);
    expect(t!.weeklyAverageGrams).toBeGreaterThan(100);
  });

  it("assembles tracked, logged and estimated days through one composition", () => {
    const p = newProfile("trailing-parts");
    const anchor = today(p);
    seedWeight(p, anchor, 80);
    const d1 = shiftDateStr(anchor, -1);
    const d2 = shiftDateStr(anchor, -2);
    const d3 = shiftDateStr(anchor, -3);
    seedTrackedProtein(p, d1, 120); // a measured total — overrides
    logFood(p, d1, "poultry", 1); // …so this 35 g estimate does not count
    addProtein(p, d2, 60);
    logFood(p, d2, "poultry", 1); // 35 estimated + 60 logged = 95
    logFood(p, d3, "eggs", 1); // estimated only
    // Today, deliberately far off the ~76 g the window should report, so a leak
    // would be unmissable. Under the per-add cap — an over-cap amount is refused,
    // not clamped, and would seed nothing at all.
    //
    // It also has to LAND for this assertion to be reached on every weekday. With
    // today's protein present, getProteinToday composes through getProteinOnDate
    // and never consults the week-to-date window; with it missing, the gather falls
    // back to that window, and on the profile's week-start day (Sunday by default)
    // the window is today alone, so the gauge is null and `t!` throws — which is the
    // #2327 CI break. The window here is TRAILING and day-of-week independent by
    // construction: do not "fix" a failure in this file by pinning a clock.
    addProtein(p, anchor, 250);

    const eggs = 12; // one serving of eggs, per the food-group catalog
    const t = getProteinToday(p);
    expect(t!.trailing.grams).toBeCloseTo((120 + 95 + eggs) / 3, 6);
  });

  it("a day-one profile's trailing figure is marked, and the card declines it", () => {
    const p = newProfile("trailing-day-one");
    const anchor = today(p);
    seedWeight(p, anchor, 80);
    addProtein(p, anchor, 84); // the first protein ever logged

    const t = getProteinToday(p);
    expect(t!.trailing).toEqual({ grams: 84, dayOne: true });
  });

  it("a stale log leaves the window empty rather than falling back to today", () => {
    const p = newProfile("trailing-stale");
    const anchor = today(p);
    seedWeight(p, anchor, 80);
    addProtein(p, shiftDateStr(anchor, -20), 130);
    addProtein(p, anchor, 84);

    const t = getProteinToday(p);
    expect(t!.trailing).toEqual({ grams: null, dayOne: false });
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
