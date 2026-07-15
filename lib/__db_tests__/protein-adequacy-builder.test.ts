// DB INTEGRATION TIER — the #448 end-to-end fixture for the protein-adequacy coaching
// builder (issue #767): a day with logged protein-group servings + a bodyweight yields an
// ESTIMATED band and a calm below-goal finding; adding an integration protein_g overrides
// the intake basis to TRACKED. Also pins tier discipline (joins collectCoachingFindings,
// parses against RULE_FINDING_PREFIXES, never leaves the coaching tier).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  buildProteinAdequacyFindings,
  collectCoachingFindings,
} from "@/lib/rule-findings";
import { getProteinAdequacy } from "@/lib/queries";
import { dedupeKeyHasKnownPrefix } from "@/lib/rule-finding-prefixes";
import {
  PROTEIN_ADEQUACY_PREFIX,
  proteinAdequacySignalKey,
} from "@/lib/protein";

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

describe("buildProteinAdequacyFindings (#767)", () => {
  it("estimates a floor from logged servings and surfaces a calm below-goal finding", () => {
    const p = newProfile("protein-below");
    const anchor = today(p);
    seedWeight(p, anchor, 80); // active target ~95–130 g/day
    // ~51 g of logged protein today — well under the floor of the band.
    logFood(p, anchor, "poultry", 1); // 35
    logFood(p, anchor, "eggs", 1); // 12
    logFood(p, anchor, "leafy_greens", 2); // 2 × 2 = 4

    const a = getProteinAdequacy(p);
    expect(a?.intake.basis).toBe("estimated");
    expect(a?.status).toBe("below");
    expect(Math.round(a!.intake.grams)).toBe(51);
    expect(a?.target.massBasis).toBe("total");

    const findings = buildProteinAdequacyFindings(p);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.dedupeKey).toBe(proteinAdequacySignalKey());
    expect(f.dedupeKey.startsWith(PROTEIN_ADEQUACY_PREFIX)).toBe(true);
    expect(dedupeKeyHasKnownPrefix(f.dedupeKey)).toBe(true);
    // Coaching tier: a calm info tone, floor-caveated, never a push/hero.
    expect(f.tone).toBe("info");
    expect(f.detail).toMatch(/floor/i);
    expect(f.detail).not.toMatch(/deficien/i);
    expect(f.actionHref).toBe("/nutrition");

    // It joins the unified coaching rollup (dismiss-once-silence-everywhere).
    const rolled = collectCoachingFindings(p, anchor, "kg").map(
      (x) => x.dedupeKey
    );
    expect(rolled).toContain(f.dedupeKey);
  });

  it("overrides to a TRACKED basis when an integration protein_g is present", () => {
    const p = newProfile("protein-tracked");
    const anchor = today(p);
    seedWeight(p, anchor, 80);
    // Same modest logged servings (would estimate ~51)…
    logFood(p, anchor, "poultry", 1);
    logFood(p, anchor, "eggs", 1);
    // …but a measured 140 g/day from the integration wins.
    seedTrackedProtein(p, anchor, 140);

    const a = getProteinAdequacy(p);
    expect(a?.intake.basis).toBe("tracked");
    expect(Math.round(a!.intake.grams)).toBe(140);
    // 140 is above the ~95–130 band → no shortfall finding (above, not below).
    expect(a?.status).toBe("above");
    expect(buildProteinAdequacyFindings(p)).toEqual([]);
  });

  it("stays silent without a bodyweight to scale a target by", () => {
    const p = newProfile("protein-noweight");
    const anchor = today(p);
    logFood(p, anchor, "poultry", 1);
    expect(getProteinAdequacy(p)).toBeNull();
    expect(buildProteinAdequacyFindings(p)).toEqual([]);
  });

  it("stays silent with a bodyweight but no logged food and no tracked protein", () => {
    const p = newProfile("protein-nofood");
    const anchor = today(p);
    seedWeight(p, anchor, 80);
    expect(getProteinAdequacy(p)).toBeNull();
    expect(buildProteinAdequacyFindings(p)).toEqual([]);
  });

  it("prefers lean body mass when a lean_mass_kg sample is present", () => {
    const p = newProfile("protein-lean");
    const anchor = today(p);
    seedWeight(p, anchor, 90);
    db.prepare(
      `INSERT INTO metric_samples (profile_id, source, metric, date, start_time, end_time, value)
       VALUES (?, 'withings', 'lean_mass_kg', ?, ?, ?, 60)`
    ).run(p, anchor, `${anchor}T08:00:00Z`, `${anchor}T08:00:00Z`);
    logFood(p, anchor, "poultry", 1);

    const a = getProteinAdequacy(p);
    expect(a?.target.massBasis).toBe("lean");
    expect(a?.target.massKg).toBe(60);
  });
});
