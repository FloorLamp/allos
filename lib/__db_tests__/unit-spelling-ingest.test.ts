// DB INTEGRATION TIER (#448 / #759) — biomarker units are stored VERBATIM at
// ingest, so a real-world spelling the parser must fold (e.g. LabCorp/Quest's
// "gm/dL" for grams-per-deciliter) reaches the read layer as-is. The pure tier
// pins the parser's unitKey/convert result; only this tier proves the END-TO-END
// consequence the issue is about: a reading ingested in "gm/dL" above the
// canonical range derives a HIGH flag (through the real reconcileFlags UPDATE) AND
// joins the SAME trend series as a "g/dL" reading (through the real dedup/series
// query). A mis-parse would silently drop the flag and split the chart. All values
// are SYNTHETIC (no PHI).

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  reconcileFlags,
  getBiomarkerSeries,
  getLatestMedicalRecordByCanonical,
} from "@/lib/queries";
import { seedProfile, type SeededProfile } from "./fixtures";

let p: SeededProfile;

function addHemoglobin(date: string, value: number, unit: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, unit, canonical_name, value_num, panel)
         VALUES (?, ?, 'lab', 'Hemoglobin', ?, ?, 'Hemoglobin', ?, 'Hgb759')`
      )
      .run(p.profileId, date, String(value), unit, value).lastInsertRowid
  );
}

beforeEach(() => {
  p = seedProfile("HGB759");
  db.prepare(
    "DELETE FROM medical_records WHERE profile_id = ? AND panel = 'Hgb759'"
  ).run(p.profileId);
});

describe("verbatim gm/dL ingest → flag + series, same as g/dL (#759)", () => {
  it("a gm/dL reading above the range flags HIGH and joins the g/dL series", () => {
    // Hemoglobin canonical unit is g/dL (adult ref band 12–17.5). The abnormal
    // reading is spelled "gm/dL" (the LabCorp/Quest grams spelling); the normal
    // one is plain "g/dL". Distinct dates so neither is a cross-source dedup twin.
    const abnormalDate = shiftDateStr(p.todayStr, -10);
    const normalDate = shiftDateStr(p.todayStr, -40);
    const abnormalId = addHemoglobin(abnormalDate, 19.0, "gm/dL"); // > 17.5 → high
    const normalId = addHemoglobin(normalDate, 14.0, "g/dL"); // in-range

    // FLAG: the verbatim "gm/dL" is parsed as g/dL, converts to the canonical unit,
    // and reconcileFlags (the real UPDATE path) derives HIGH — not the silent
    // no-flag a mis-parse would leave. The in-range g/dL reading stays unflagged,
    // proving the flag came from the value crossing the range, not the spelling.
    expect(reconcileFlags(p.profileId)).toBeGreaterThanOrEqual(1);
    const flagOf = (id: number) =>
      (
        db.prepare("SELECT flag FROM medical_records WHERE id = ?").get(id) as {
          flag: string | null;
        }
      ).flag;
    expect(flagOf(abnormalId)).toBe("high");
    expect(flagOf(normalId) ?? null).not.toBe("high");
    expect(
      getLatestMedicalRecordByCanonical(p.profileId, "Hemoglobin")
        ?.canonical_name
    ).toBe("Hemoglobin");

    // SERIES: both readings resolve into ONE Hemoglobin series (the gm/dL spelling
    // is not split out), oldest-first.
    const series = getBiomarkerSeries(p.profileId, "Hemoglobin");
    expect(series.map((r) => r.value_num)).toEqual([14.0, 19.0]);
    expect(series.map((r) => r.unit)).toEqual(["g/dL", "gm/dL"]);
  });
});
