// DB INTEGRATION TIER — the dose LIFETIME bound is computed from the same evidence
// everywhere it is computed at all (#3988/#4020).
//
// `doseWindowSince` answers "when did this dose first exist", and that question has no
// window: it is widened backwards by the dose's own logged history, because a log is
// proof the dose existed on its date. A caller that feeds it a WINDOWED read therefore
// bounds an unbounded question by its own drawing length — and #4010 converted five
// call sites on exactly that finding while a sixth, the adherence-PATTERN detector,
// kept `getIntakeLogsInRange`. A reconciled medication whose only proof of existence is
// a backfilled administration older than the window then had two bounds a hundred days
// apart, in a pair of comments that each said it could not.
//
// ── THE CENSUS, and it is the artifact here ──────────────────────────────────
// Two earlier sweeps of this question each missed one caller, both times by counting a
// narrower set than "sites that compute the bound". The membership test is not "imports
// doseWindowSince" (that misses every site reaching it THROUGH `intakeAdherenceStrip`,
// and matches comments that merely name it) — it is "builds the status index the bound
// reads". So the search is over `indexTakenByDose`, which is the only way to build one:
//
//   git grep -n 'indexTakenByDose' -- '*.ts' '*.tsx' | grep -v __tests__
//
// and then, per hit, which read feeds it. On 2026-08-29 that was eight production
// sites: six on `getIntakeAdherenceEvidence` (med-data ×2, SupplementsTab,
// intake-history, notifications/intake, and rule-findings as of this change), one on
// `pendingDayDoses`'s own unbounded MIN query, and `lib/queries/sleep.ts:423` — which
// feeds `getIntakeLogsInRange` to an index used ONLY for window-local taken/skipped
// facts, and takes its own bound from `doseExistsSince` (the un-widened one) by the
// deliberate #1972/#1973 rule that a logged night renders on the strength of its log.
// It is the seventh site and not a seventh instance of this defect; whether its bound
// should widen too is a separate question about bedtime history, not about this one.
//
// Runs via `npm run test:db` (vitest.db.config.ts).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr, lastNDates } from "@/lib/date";
import { setTimezone, getTimezone } from "@/lib/settings";
import { getIntakeAdherenceEvidence } from "@/lib/queries";
import { doseWindowSince, indexTakenByDose } from "@/lib/intake-adherence";
import { ADHERENCE_PATTERN_DAYS, weekdayIndex } from "@/lib/adherence-patterns";
import { buildAdherencePatternFindings } from "@/lib/rule-findings";

const FRIDAY = 5;

describe("the adherence-pattern window is bounded by the same evidence as the strip (#4020)", () => {
  it("reads back to a backfilled proof of existence, not to today's created_at", () => {
    const profileId = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('Bound Evidence')").run()
        .lastInsertRowid
    );
    setTimezone(profileId, "UTC");
    const td = today(profileId);
    const born = `${td} 09:00:00`;
    // A RECONCILED medication (#1442's own scenario): the rows were created this
    // morning, and a backfilled administration is the only proof it existed before.
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, kind, active, obligation, condition, created_at)
           VALUES (?, 'Backfilled med', 'medication', 1, 'must', 'daily', ?)`
        )
        .run(profileId, born).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses
             (item_id, amount, time_of_day, food_timing, sort, created_at)
           VALUES (?, '1 tab', 'Evening', 'any', 0, ?)`
        )
        .run(itemId, born).lastInsertRowid
    );
    const log = db.prepare(
      `INSERT INTO intake_item_logs (dose_id, date, status) VALUES (?, ?, 'taken')`
    );
    const proof = shiftDateStr(td, -100);
    log.run(doseId, proof);

    // A ledger that starts again about five weeks ago: every Friday missed, three
    // recent non-Fridays missed, everything else taken. Judged over the FULL lifetime
    // window the misses are Friday-shaped; judged from `created_at` there is no window
    // at all. The first non-Friday at or before day-35 anchors where the logs resume,
    // so the shorter bound is deterministic rather than weekday-dependent.
    const window = lastNDates(td, ADHERENCE_PATTERN_DAYS).slice(0, -1);
    let resume = 35;
    while (weekdayIndex(shiftDateStr(td, -resume)) === FRIDAY) resume += 1;
    const recent = window.filter((d) => d >= shiftDateStr(td, -resume));
    const recentNonFridays = recent.filter((d) => weekdayIndex(d) !== FRIDAY);
    const missedLately = new Set(recentNonFridays.slice(-3));
    for (const d of recentNonFridays)
      if (!missedLately.has(d)) log.run(doseId, d);

    const tz = getTimezone(profileId);
    const item = db
      .prepare("SELECT created_at FROM intake_items WHERE id = ?")
      .get(itemId) as { created_at: string };
    // The bound every STRIP caller computes, from the evidence read #3988 gave it.
    const stripBound = doseWindowSince(
      item.created_at,
      born,
      indexTakenByDose(
        getIntakeAdherenceEvidence(profileId, ADHERENCE_PATTERN_DAYS)
      ).get(doseId),
      tz
    );
    expect(stripBound).toBe(proof);

    // …and the bound the PATTERN detector used, read back out of the sentence it
    // publishes: the finding names its own denominator, so the number of Fridays it
    // scored IS its window. Asserted against the strip's bound rather than against a
    // literal — the two seams have to agree, and a literal would agree with itself on
    // a tree where both were wrong.
    const fridaysInStripWindow = window.filter(
      (d) => d >= stripBound! && weekdayIndex(d) === FRIDAY
    ).length;
    const finding = buildAdherencePatternFindings(profileId, td).find((f) =>
      f.title.includes("Backfilled med")
    );
    expect(finding?.detail).toContain(
      `${fridaysInStripWindow} of the last ${fridaysInStripWindow}`
    );
  });
});
