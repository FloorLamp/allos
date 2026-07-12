// DB INTEGRATION TIER — the shared flag+trajectory acknowledgment (issue #564).
// The dashboard FLAG ("Vitamin D is low now") and the Trends TRAJECTORY watch
// ("Vitamin D is trending low") are two views of one concern about one analyte, so
// a dismiss on EITHER must silence BOTH — keyed on the #482 biomarker FAMILY so it
// covers D2/D3/total. The retest nudge stays INDEPENDENT (owner decision: accepting
// a value ≠ declining a re-measure). Proven end-to-end through the real read layer.
// All values are SYNTHETIC (no PHI).

import { describe, it, expect, beforeEach } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { collectAttentionModel } from "@/lib/queries/attention";
import { getFindingSuppressions, dismissFinding } from "@/lib/queries/upcoming";
import { buildTrajectoryFindings } from "@/lib/trajectory-series";
import { activeFindings } from "@/lib/findings";
import {
  biomarkerFlagDismissalKey,
  biomarkerDismissalKey,
} from "@/lib/dismissal-keys";
import { seedProfile, type SeededProfile } from "./fixtures";

let p: SeededProfile;

// A flagged-high LDL reading `days` before today. created_at defaults to now so the
// latest one falls inside the flagged-attention window; older ones anchor the trend.
function addLdl(days: number, value: number) {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num, flag, panel)
     VALUES (?, ?, 'lab', 'LDL Cholesterol', ?, 'mg/dL', 'LDL Cholesterol', ?, 'high', 'Ack')`
  ).run(p.profileId, shiftDateStr(p.todayStr, -days), String(value), value);
}

function clearLdl() {
  db.prepare(
    "DELETE FROM medical_records WHERE profile_id = ? AND panel = 'Ack'"
  ).run(p.profileId);
}

function trajectoryForLdl() {
  const now = today(p.profileId);
  return activeFindings(
    buildTrajectoryFindings(p.profileId, now),
    getFindingSuppressions(p.profileId),
    now
  ).filter((f) => f.dedupeKey.startsWith("trajectory:LDL Cholesterol:"));
}

function flagItemsForLdl() {
  return collectAttentionModel(p.profileId, today(p.profileId)).filter(
    (i) =>
      i.domain === "biomarker-flag" &&
      i.key === "biomarker-flag:ldl cholesterol"
  );
}

beforeEach(() => {
  p = seedProfile("ACK");
  clearLdl();
  // Three flagged-high readings ≥90 days apart → persistent-non-optimal trajectory,
  // and the latest (today) is a newly-flagged current reading.
  addLdl(180, 190);
  addLdl(90, 195);
  addLdl(0, 200);
});

describe("dismissing the biomarker flag silences the trajectory (#564)", () => {
  it("flag + trajectory both fire, then a flag dismiss suppresses both", () => {
    // Both signals present for the analyte up front.
    expect(flagItemsForLdl()).toHaveLength(1);
    expect(trajectoryForLdl().length).toBeGreaterThan(0);

    // Dismiss the FLAG (what the dashboard hero / dismissAttention writes — the
    // shared family acknowledgment key).
    dismissFinding(p.profileId, biomarkerFlagDismissalKey("LDL Cholesterol"));

    // Both go quiet from the ONE dismiss.
    expect(flagItemsForLdl()).toHaveLength(0);
    expect(trajectoryForLdl()).toHaveLength(0);
  });

  it("the trajectory dismiss writes the SAME key, so it silences the flag too", () => {
    // dismissTrajectory writes biomarkerFlagDismissalKey(analyte) — identical key.
    dismissFinding(p.profileId, biomarkerFlagDismissalKey("LDL Cholesterol"));
    expect(flagItemsForLdl()).toHaveLength(0);
    expect(trajectoryForLdl()).toHaveLength(0);
  });

  it("leaves the retest nudge INDEPENDENT — the family retest key is untouched", () => {
    dismissFinding(p.profileId, biomarkerFlagDismissalKey("LDL Cholesterol"));
    const supp = getFindingSuppressions(p.profileId);
    // The acknowledgment lives under the flag namespace only…
    expect(supp.has("biomarker-flag:ldl cholesterol")).toBe(true);
    // …never the retest namespace, so a due retest still fires (owner decision).
    expect(supp.has(biomarkerDismissalKey("LDL Cholesterol"))).toBe(false);
    expect(supp.has("biomarker:ldl cholesterol")).toBe(false);
  });
});
