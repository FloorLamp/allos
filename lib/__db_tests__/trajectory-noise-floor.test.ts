// DB INTEGRATION TIER — the measurement-noise floor (issue #563) end-to-end through
// the real query/assembly layer (lib/trajectory-series → lib/biomarker-trajectory),
// grounded on the SEEDED canonical "Oxygen Saturation" entry (ref/optimal 95–100,
// higher_better) so the ranges + curated ±2 floor come from production data, not a
// hand-built input. The reported bug: a 98→97 SpO2 series (one integer point, inside
// a pulse-oximeter's ±2% error) projected a confident "crosses 95" decline. A genuine
// multi-unit decline must still fire. All values are SYNTHETIC (no PHI).

import { describe, it, expect, beforeEach } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { buildTrajectoryFindings } from "@/lib/trajectory-series";
import { seedProfile, type SeededProfile } from "./fixtures";

let p: SeededProfile;

// A canonical Oxygen Saturation reading `days` before today, tagged so we can wipe
// them between cases.
function addSpo2(days: number, value: number) {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num, panel)
     VALUES (?, ?, 'vitals', 'Oxygen Saturation', ?, '%', 'Oxygen Saturation', ?, 'Spo2')`
  ).run(p.profileId, shiftDateStr(p.todayStr, -days), String(value), value);
}

function clearSpo2() {
  db.prepare(
    "DELETE FROM medical_records WHERE profile_id = ? AND panel = 'Spo2'"
  ).run(p.profileId);
}

function spo2ApproachingCount(): number {
  return buildTrajectoryFindings(p.profileId, today(p.profileId)).filter(
    (f) =>
      f.rule === "approaching" &&
      f.dedupeKey.startsWith("trajectory:Oxygen Saturation:")
  ).length;
}

beforeEach(() => {
  p = seedProfile("SPO2");
  clearSpo2();
});

describe("trajectory noise floor for a near-ceiling bounded vital (#563)", () => {
  it("a 98→97 SpO2 wiggle (within ±2 device error) fires NO trajectory finding", () => {
    // 4 readings over ~9 months, a single integer point of decline.
    addSpo2(270, 98);
    addSpo2(180, 98);
    addSpo2(90, 97);
    addSpo2(0, 97);
    expect(spo2ApproachingCount()).toBe(0);
  });

  it("a genuine multi-unit decline (99→96, range > ±2) still fires", () => {
    addSpo2(270, 99);
    addSpo2(180, 98);
    addSpo2(90, 97);
    addSpo2(0, 96);
    expect(spo2ApproachingCount()).toBeGreaterThan(0);
  });
});
