// DB INTEGRATION TIER — the retest-worthiness inclusion gate + age ceiling
// (issues #546 / #587). Proves end-to-end against the real query layer that:
//   • a worthy recurring analyte (LDL Cholesterol) past its clock nudges,
//   • an incidental non-worthy one-off (Lead / Mercury / allergen IgE) is DROPPED
//     from the retest nudge entirely — whether its flag is normal or flagged high —
//     rather than demoted to a -1 tier (which was invisible alone in its band, #587),
//   • a flagged non-worthy reading still surfaces on the flag/needs-review path
//     (getCurrentFlaggedBiomarkers), which is where it belongs,
//   • a non-worthy analyte that IS risk-elevated (mod.priority > 0, e.g. a hepatitis-A
//     titer for a healthcare worker) KEEPS its retest clock,
//   • a reading past the ~10-year age ceiling drops OUT of the retest nudge entirely.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { collectUpcoming, getCurrentFlaggedBiomarkers } from "@/lib/queries";
import type { UpcomingItem } from "@/lib/upcoming";
import { seedProfile, type SeededProfile } from "./fixtures";

let p: SeededProfile;

function addReading(
  canonical: string,
  date: string,
  value: number,
  unit = "",
  flag: string | null = null
) {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num, flag)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, ?, ?)`
  ).run(
    p.profileId,
    date,
    canonical,
    String(value),
    unit,
    canonical,
    value,
    flag
  );
}

function biomarkerItems(): UpcomingItem[] {
  return collectUpcoming(p.profileId, p.todayStr).filter(
    (i) => i.domain === "biomarker"
  );
}

beforeAll(() => {
  p = seedProfile("RETESTWORTH");
  db.prepare(
    "DELETE FROM medical_records WHERE profile_id = ? AND category = 'lab'"
  ).run(p.profileId);
  // Worthy lipid, 2 years stale, normal flag, no risk elevation → nudge YES.
  addReading("LDL Cholesterol", shiftDateStr(p.todayStr, -730), 130, "mg/dL");
  // Incidental heavy metal, 2 years stale, NORMAL → dropped (NO nudge).
  addReading("Lead", shiftDateStr(p.todayStr, -730), 1, "ug/dL", "normal");
  // Incidental heavy metal, 2 years stale, FLAGGED HIGH, no risk elevation →
  // dropped from the retest nudge but must still surface on the flag path.
  addReading("Mercury", shiftDateStr(p.todayStr, -730), 20, "ug/L", "high");
  // Incidental allergen-specific IgE, 2 years stale, FLAGGED, no risk elevation → NO.
  addReading("Peanut IgE", shiftDateStr(p.todayStr, -730), 15, "kU/L", "high");
  // Non-worthy analyte that IS risk-elevated: a plain hepatitis-A reading paired
  // with the healthcare-worker occupational attribute → retestModulationFor gives
  // priority 1 (mod.priority > 0), so it keeps its retest clock. (Named without
  // "IgG/antibody" so it isn't treated as a durable-immunity titer, #516.)
  addReading("Hepatitis A", shiftDateStr(p.todayStr, -730), 1, "", "high");
  db.prepare(
    `INSERT INTO profile_settings (profile_id, key, value)
     VALUES (?, 'risk_healthcare_worker', '1')`
  ).run(p.profileId);
  // Worthy lipid whose ONLY reading is ~15 years old — historical baseline.
  addReading("ApoB", shiftDateStr(p.todayStr, -5500), 90, "mg/dL");
});

describe("retest-worthiness inclusion gate + age ceiling (#546 / #587)", () => {
  it("nudges a worthy stale lipid at its normal priority", () => {
    const ldl = biomarkerItems().find((i) => i.key.includes("ldl cholesterol"));
    expect(ldl).toBeTruthy();
    expect(ldl!.priority ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("drops an incidental one-off with a NORMAL flag from the retest nudge", () => {
    const lead = biomarkerItems().find((i) => i.key.includes("lead"));
    expect(lead).toBeUndefined();
  });

  it("drops an incidental one-off that is FLAGGED but not risk-elevated", () => {
    const mercury = biomarkerItems().find((i) => i.key.includes("mercury"));
    expect(mercury).toBeUndefined();
    const ige = biomarkerItems().find((i) => i.key.includes("peanut ige"));
    expect(ige).toBeUndefined();
  });

  it("still surfaces the flagged non-worthy reading on the flag/needs-review path", () => {
    const flagged = getCurrentFlaggedBiomarkers(p.profileId);
    const names = flagged.map((f) => f.name.toLowerCase());
    expect(names).toContain("mercury");
    expect(names).toContain("peanut ige");
  });

  it("keeps a risk-elevated non-worthy analyte in the retest nudge", () => {
    const hepA = biomarkerItems().find((i) => i.key.includes("hepatitis a"));
    expect(hepA).toBeTruthy();
    expect(hepA!.priority ?? 0).toBeGreaterThan(0);
  });

  it("drops a ~15-year-old reading past the age ceiling entirely", () => {
    const apob = biomarkerItems().find((i) => i.key.includes("apob"));
    expect(apob).toBeUndefined();
  });
});
