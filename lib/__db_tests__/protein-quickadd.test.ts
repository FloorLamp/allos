// DB INTEGRATION TIER (#448) — the protein-grams quick-add end-to-end (issue #824): the
// direct-grams `logged` basis SUMMED with the food-group `estimated` floor, OVERRIDDEN by
// an integration's `tracked` protein_g, and an undo that removes the grams from the same
// day's total. Drives the real write cores (addProteinGramsCore/undoProteinGramsCore) and
// asserts the finding output of getProteinAdequacy — the ONE gather the card + coaching
// finding both format — so the composition can't drift between the two surfaces.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  addProteinGramsCore,
  undoProteinGramsCore,
} from "@/lib/protein-log-write";
import { getProteinAdequacy, getProteinLoggedGrams } from "@/lib/queries";
import { buildProteinAdequacyFindings } from "@/lib/rule-findings";

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

describe("protein-grams quick-add end-to-end (#824)", () => {
  it("SUMS logged grams onto the food-group estimated floor (a manual entry is a partial addition)", () => {
    const p = newProfile("protein-sum");
    const anchor = today(p);
    seedWeight(p, anchor, 80); // active target ~95–130 g/day
    // Food groups estimate ~47 g (poultry 35 + eggs 12), a below-band floor…
    logFood(p, anchor, "poultry", 1);
    logFood(p, anchor, "eggs", 1);

    // …then a 30 g shake is logged directly.
    const out = addProteinGramsCore(p, anchor, 30);
    expect(out).toEqual({ kind: "logged", grams: 30 });
    expect(getProteinLoggedGrams(p, anchor)).toBe(30);

    const a = getProteinAdequacy(p);
    expect(a?.intake.basis).toBe("combined");
    // The floor is the SUM: ~47 estimated + 30 logged = ~77, not 30 (no eraser).
    expect(Math.round(a!.intake.grams)).toBe(77);
    expect(Math.round(a!.intake.estimatedGrams)).toBe(47);
    expect(Math.round(a!.intake.loggedGrams)).toBe(30);
    expect(a?.status).toBe("below"); // 77 < 95

    // The coaching finding is calm + floor-caveated (never a deficiency claim).
    const findings = buildProteinAdequacyFindings(p);
    expect(findings).toHaveLength(1);
    expect(findings[0].detail).toMatch(/floor/i);
    expect(findings[0].detail).not.toMatch(/deficien/i);
  });

  it("is `logged` (still a floor) when only grams are logged, no protein-bearing foods", () => {
    const p = newProfile("protein-loggedonly");
    const anchor = today(p);
    seedWeight(p, anchor, 80);
    addProteinGramsCore(p, anchor, 50);

    const a = getProteinAdequacy(p);
    expect(a?.intake.basis).toBe("logged");
    expect(Math.round(a!.intake.grams)).toBe(50);
  });

  it("a tracked integration protein_g OVERRIDES the estimated+logged sum", () => {
    const p = newProfile("protein-override");
    const anchor = today(p);
    seedWeight(p, anchor, 80);
    logFood(p, anchor, "poultry", 1); // ~35 estimated
    addProteinGramsCore(p, anchor, 30); // +30 logged → sum ~65
    // …but a measured 150 g/day from the integration wins.
    seedTrackedProtein(p, anchor, 150);

    const a = getProteinAdequacy(p);
    expect(a?.intake.basis).toBe("tracked");
    expect(Math.round(a!.intake.grams)).toBe(150);
    expect(a!.intake.loggedGrams).toBe(0); // the sum's parts are dropped under override
    // 150 is above the ~95–130 band → no shortfall finding.
    expect(a?.status).toBe("above");
    expect(buildProteinAdequacyFindings(p)).toEqual([]);
  });

  it("undo removes the grams from the same day's total, reverting the basis", () => {
    const p = newProfile("protein-undo");
    const anchor = today(p);
    seedWeight(p, anchor, 80);
    logFood(p, anchor, "poultry", 1); // ~35 estimated (below-band floor)
    addProteinGramsCore(p, anchor, 30); // → combined ~65

    let a = getProteinAdequacy(p);
    expect(a?.intake.basis).toBe("combined");
    expect(Math.round(a!.intake.grams)).toBe(65);

    // Undo the shake → back to the estimated floor alone.
    const undone = undoProteinGramsCore(p, anchor, 30);
    expect(undone).toEqual({ kind: "undone", grams: 0 });
    expect(getProteinLoggedGrams(p, anchor)).toBe(0);
    // The row is dropped at zero — no stray protein_log row survives.
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM protein_log WHERE profile_id = ?")
        .get(p)
    ).toEqual({ n: 0 });

    a = getProteinAdequacy(p);
    expect(a?.intake.basis).toBe("estimated");
    expect(Math.round(a!.intake.grams)).toBe(35);
  });
});
