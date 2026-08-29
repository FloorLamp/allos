// AUDIT PROBE (audit-0829) — not a shipped guard. #3988/#4010 gave the strip's lifetime
// bound its own evidence, and named five callers. `lib/rule-findings.ts` is a sixth: it
// computes the SAME `doseWindowSince` bound from the windowed `getIntakeLogsInRange`,
// and its own comment claims it "cannot disagree" with the strip. Delete with the audit.
import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone, getTimezone } from "@/lib/settings";
import {
  getIntakeLogsInRange,
  getIntakeAdherenceEvidence,
} from "@/lib/queries/intake/adherence";
import {
  indexTakenByDose,
  doseWindowSince,
  STRIP_DAYS,
} from "@/lib/intake-adherence";
import { ADHERENCE_PATTERN_DAYS } from "@/lib/adherence-patterns";

describe("PROBE: the lifetime bound, two evidence sets", () => {
  it("rule-findings' windowed read and the strip's evidence read disagree", () => {
    const pid = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('Evidence Probe')").run()
        .lastInsertRowid
    );
    setTimezone(pid, "UTC");
    const td = today(pid);
    // A reconciled medication: the item row was created TODAY, and a backfilled
    // administration proves it existed 100 days ago (#1442's own scenario).
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, kind, active, obligation, condition, created_at)
           VALUES (?, 'Backfilled med', 'medication', 1, 'must', 'daily', ?)`
        )
        .run(pid, `${td} 09:00:00`).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, created_at)
           VALUES (?, '1 tab', 'Morning', 'any', 0, ?)`
        )
        .run(itemId, `${td} 09:00:00`).lastInsertRowid
    );
    const proof = shiftDateStr(td, -100);
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, date, status) VALUES (?, ?, 'taken')`
    ).run(doseId, proof);

    const tz = getTimezone(pid);
    const bound = (
      rows: { dose_id: number; date: string; status: "taken" | "skipped" }[]
    ) =>
      doseWindowSince(
        `${td} 09:00:00`,
        `${td} 09:00:00`,
        indexTakenByDose(rows).get(doseId),
        tz
      );
    // What lib/rule-findings.ts:1537 builds (56-day window).
    const patterns = bound(getIntakeLogsInRange(pid, ADHERENCE_PATTERN_DAYS));
    // What every strip caller builds since #3988.
    const strip = bound(getIntakeAdherenceEvidence(pid, STRIP_DAYS));
    console.log("  backfilled proof of existence :", proof);
    console.log("  rule-findings bound (windowed):", patterns);
    console.log("  strip bound (own evidence)    :", strip);
    // AUDIT PIN — the DEFECT as it stands at fb8e79d83. INVERT to `toBe(strip)` when
    // lib/rule-findings.ts joins the other five callers on getIntakeAdherenceEvidence.
    expect(patterns).toBe(td);
    expect(strip).toBe(proof);
  });
});
