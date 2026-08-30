// DB INTEGRATION TIER — a NEW DRAW re-arms the flagged-result acknowledgment (#3225).
//
// Owner ruling 2026-08-20, amending #564: "acknowledge writes the flag key, and a new
// draw clears the suppression, restoring both the dashboard flag and the Trends
// trajectory watch." The COUPLING half of #564 is untouched (flag-trajectory-ack.test.ts
// still owns it); what is narrowed is the PERMANENCE — "a dismissal now lasts until
// the next draw of that marker family, not indefinitely."
//
// Follow-up ruling 2026-08-20 — what counts as a new draw: "Any new reading of that
// marker family. Not 'a worse one', not 'one whose flag differs'." The rejected
// readings both fail quietly: "only worse" needs a per-analyte direction and getting
// one backwards is silent, and "only when the flag changes" is blind to movement
// inside a band — 200 → 260 is still `high`.
//
// So this table is written to DISCRIMINATE, not merely to pass. The `steady` row is a
// new reading that is BETTER than the acknowledged one and carries the SAME flag: it
// re-arms under the picked rule and stays silent under BOTH rejected ones, so a tree
// that implemented either of those fails here. The `no new draw` case is the negative
// control that keeps the whole table from being vacuous.
//
// Proven end-to-end through the real read layer. All values are SYNTHETIC (no PHI).

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
import type { MedicalFlag } from "@/lib/types";
import { seedProfile, type SeededProfile } from "./fixtures";

let p: SeededProfile;

const ACK_KEY = biomarkerFlagDismissalKey("LDL Cholesterol");

// One LDL reading. `arrivedSql` is the row's `created_at` — WHEN IT ARRIVED, which is
// the only quantity the re-arm reads — kept separate from `days`, the COLLECTION day
// the trend and the flagged-attention window read. Splitting the two is what lets the
// fixture put a reading either side of an acknowledgment instant deterministically;
// attention-flagged-window.test.ts separates them the same way.
function addLdl(
  days: number,
  value: number,
  flag: MedicalFlag,
  arrivedSql: string
) {
  db.prepare(
    `INSERT INTO medical_records
       (profile_id, date, category, name, value, unit, canonical_name, value_num, flag, panel, created_at)
     VALUES (?, ?, 'lab', 'LDL Cholesterol', ?, 'mg/dL', 'LDL Cholesterol', ?, ?, 'AckDraw', ${arrivedSql})`
  ).run(p.profileId, shiftDateStr(p.todayStr, -days), String(value), value, flag);
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
    (i) => i.domain === "biomarker-flag" && i.key === ACK_KEY
  );
}

// Acknowledge, then place the acknowledgment an hour ago. The baseline readings
// arrived a day ago, so they sit BEFORE it (readings you had already seen) and any
// row added afterwards sits AFTER it. Without this the whole fixture lands inside one
// `datetime('now')` second and nothing is ordered at all.
function acknowledgeAnHourAgo() {
  dismissFinding(p.profileId, ACK_KEY);
  db.prepare(
    `UPDATE upcoming_dismissals SET dismissed_at = datetime('now', '-1 hour')
      WHERE profile_id = ? AND signal_key = ?`
  ).run(p.profileId, ACK_KEY);
}

beforeEach(() => {
  p = seedProfile("ACKDRAW");
  db.prepare(
    "DELETE FROM medical_records WHERE profile_id = ? AND panel = 'AckDraw'"
  ).run(p.profileId);
  // The same three flagged-high readings #564's test uses — ≥90 days apart, latest
  // today — so both signals fire before anything is acknowledged. They ARRIVED a day
  // ago: they are the readings the acknowledgment below is about.
  addLdl(180, 190, "high", "datetime('now', '-1 day')");
  addLdl(90, 195, "high", "datetime('now', '-1 day')");
  addLdl(0, 200, "high", "datetime('now', '-1 day')");
});

describe("a new draw re-arms the flagged-result acknowledgment (#3225)", () => {
  it("both signals fire, and the acknowledgment silences both until a draw arrives", () => {
    expect(flagItemsForLdl()).toHaveLength(1);
    expect(trajectoryForLdl().length).toBeGreaterThan(0);

    acknowledgeAnHourAgo();

    // NEGATIVE CONTROL. Nothing has been drawn since, so the acknowledgment holds and
    // the #564 coupling still silences both views. Every re-arm case below is only
    // meaningful against this row.
    expect(flagItemsForLdl()).toHaveLength(0);
    expect(trajectoryForLdl()).toHaveLength(0);
  });

  // The three candidate readings of "what counts as a new draw" the issue enumerated.
  // Under the PICKED rule every row here re-arms; `silentUnderRejected` names the
  // rejected reading(s) that would instead keep it quiet, i.e. what each row
  // discriminates against. `speaksAgain` is whether the DATA still has something to
  // say once the acknowledgment is spent — a value back in range is not notable and
  // neither view speaks, which is the reading being normal and not a suppression, so
  // that row's whole claim is the spent acknowledgment.
  it.each([
    {
      label: "worse, same flag (200 → 260) — the case the ruling was made on",
      value: 260,
      flag: "high" as MedicalFlag,
      speaksAgain: true,
      silentUnderRejected: ["only when the flag differs"],
    },
    {
      label: "BETTER, same flag (200 → 190) — still a result you have not seen",
      value: 190,
      flag: "high" as MedicalFlag,
      speaksAgain: true,
      silentUnderRejected: ["only a worse one", "only when the flag differs"],
    },
    {
      label: "back in range (200 → 100) — a different flag",
      value: 100,
      flag: "normal" as MedicalFlag,
      speaksAgain: false,
      silentUnderRejected: ["only a worse one"],
    },
  ])(
    "$label re-arms both views (silent under: $silentUnderRejected)",
    ({ value, flag, speaksAgain }) => {
      acknowledgeAnHourAgo();
      expect(flagItemsForLdl()).toHaveLength(0);

      // The new draw ARRIVES now — after the acknowledgment. Collected today, like
      // the panel it supersedes.
      addLdl(0, value, flag, "datetime('now')");

      // The acknowledgment is spent. The suppression row is still THERE — a new draw
      // clears the suppression, it does not delete the user's history — but it no
      // longer reaches the read layer.
      expect(getFindingSuppressions(p.profileId).has(ACK_KEY)).toBe(false);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM upcoming_dismissals WHERE profile_id = ? AND signal_key = ?"
          )
          .get(p.profileId, ACK_KEY)
      ).toEqual({ n: 1 });

      // Both views speak again — which is also what restores the flag key to the
      // active attention set the dashboard's `clinical-non-notable-to-notable`
      // promotion is gated on.
      expect(flagItemsForLdl()).toHaveLength(speaksAgain ? 1 : 0);
      expect(trajectoryForLdl().length > 0).toBe(speaksAgain);
    }
  );

  it("a draw of ANOTHER family leaves this acknowledgment alone", () => {
    acknowledgeAnHourAgo();
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, unit, canonical_name, value_num, flag, panel, created_at)
       VALUES (?, ?, 'lab', 'Glucose', '99', 'mg/dL', 'Glucose', 99, 'normal', 'AckDraw', datetime('now'))`
    ).run(p.profileId, p.todayStr);
    expect(getFindingSuppressions(p.profileId).has(ACK_KEY)).toBe(true);
    expect(flagItemsForLdl()).toHaveLength(0);
  });

  it("re-acknowledging after the new draw silences it again", () => {
    acknowledgeAnHourAgo();
    addLdl(0, 260, "high", "datetime('now')");
    expect(flagItemsForLdl()).toHaveLength(1);

    // The upsert moves `dismissed_at` forward past the new draw, so the row is
    // self-healing and no sweep is owed. Backdated the same way for ordering.
    acknowledgeAnHourAgo();
    // …which needs the draw to sit BEFORE the new acknowledgment, as it does in life.
    db.prepare(
      `UPDATE medical_records SET created_at = datetime('now', '-2 hours')
        WHERE profile_id = ? AND panel = 'AckDraw'`
    ).run(p.profileId);
    expect(flagItemsForLdl()).toHaveLength(0);
    expect(trajectoryForLdl()).toHaveLength(0);
  });

  it("leaves the retest nudge independent, exactly as #564 ruled", () => {
    acknowledgeAnHourAgo();
    addLdl(0, 260, "high", "datetime('now')");
    const supp = getFindingSuppressions(p.profileId);
    expect(supp.has(biomarkerDismissalKey("LDL Cholesterol"))).toBe(false);
  });
});
