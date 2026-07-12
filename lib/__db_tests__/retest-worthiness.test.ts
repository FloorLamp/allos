// DB INTEGRATION TIER — the retest-worthiness tier + age ceiling (issue #546).
// Proves end-to-end against the real query layer that:
//   • a reading past the ~10-year age ceiling drops OUT of the retest nudge entirely
//     (historical baseline, not "retest overdue"),
//   • an incidental non-worthy one-off (Mercury) still surfaces but in the LOW,
//     dismissable priority tier (below 0),
//   • a recurring-monitoring analyte (LDL Cholesterol) ranks at its normal priority.

import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { collectUpcoming } from "@/lib/queries";
import type { UpcomingItem } from "@/lib/upcoming";
import { seedProfile, type SeededProfile } from "./fixtures";

let p: SeededProfile;

function addReading(canonical: string, date: string, value: number, unit = "") {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num)
     VALUES (?, ?, 'lab', ?, ?, ?, ?, ?)`
  ).run(p.profileId, date, canonical, String(value), unit, canonical, value);
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
  // A worthy lipid, 2 years stale (past its 365d cadence, under the age ceiling).
  addReading("LDL Cholesterol", shiftDateStr(p.todayStr, -730), 130, "mg/dL");
  // An incidental one-off heavy metal, 2 years stale (not retest-worthy).
  addReading("Mercury", shiftDateStr(p.todayStr, -730), 3, "ug/L");
  // A worthy lipid whose ONLY reading is ~15 years old — historical baseline.
  addReading("ApoB", shiftDateStr(p.todayStr, -5500), 90, "mg/dL");
});

describe("retest worthiness + age ceiling (#546)", () => {
  it("nudges a worthy stale lipid at its normal priority", () => {
    const ldl = biomarkerItems().find((i) => i.key.includes("ldl cholesterol"));
    expect(ldl).toBeTruthy();
    expect(ldl!.priority ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("keeps an incidental one-off in the LOW tier (priority below 0)", () => {
    const mercury = biomarkerItems().find((i) => i.key.includes("mercury"));
    expect(mercury).toBeTruthy();
    expect(mercury!.priority ?? 0).toBeLessThan(0);
    // …and it ranks below the worthy lipid.
    const ldl = biomarkerItems().find((i) => i.key.includes("ldl cholesterol"));
    expect(mercury!.priority ?? 0).toBeLessThan(ldl!.priority ?? 0);
  });

  it("drops a ~15-year-old reading past the age ceiling entirely", () => {
    const apob = biomarkerItems().find((i) => i.key.includes("apob"));
    expect(apob).toBeUndefined();
  });
});
