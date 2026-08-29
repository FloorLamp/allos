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
// ── THE CENSUS, and it is the artifact here ──────────────────────────
// THE MEMBERSHIP TEST IS "COMPUTES THE BOUND", and every wrong answer to this question
// has come from keying on something adjacent to that instead. Keying on the IMPORT of
// `doseWindowSince` misses every site that reaches it through `intakeAdherenceStrip`
// and matches comments that merely name it. Keying on `indexTakenByDose` — the index
// the bound reads — looks tighter and is worse: `pendingDayDoses` builds that index BY
// HAND from its own `MIN(l.date)` query (lib/queries/usual-routine.ts) and calls the
// bound directly, so an `indexTakenByDose` sweep cannot see the one seam this very
// change converges the reminder gather onto. Three spellings compute a dose lifetime,
// so all three are the key:
//
//   git grep -n 'doseWindowSince(\|doseExistsSince(\|intakeAdherenceStrip(' \
//     -- '*.ts' '*.tsx' ':!*__tests__*' ':!*__db_tests__*' ':!*__action_tests__*'
//
// The pathspec exclusions are not decoration: `| grep -v __tests__` does NOT exclude
// `__db_tests__` or `__action_tests__` (no double underscore before `tests`), so the
// pipe spelling silently leaves the test tiers in the result it reports on.
//
// It returns 16 lines; five are the bound's own module (lib/intake-adherence.ts — the
// two definitions, doseWindowSince's inner call, and the strip's) and one is a comment
// in lib/sleep-bedtime-supplements.ts. The other TEN are the bound call sites, over
// EIGHT evidence sources, and the verdict per site is which read fed its index:
//
//   getIntakeAdherenceEvidence — med-data.ts:286→:431, :683→:686;
//     SupplementsTab.tsx:281→:295,:362; intake-history.ts:91→:103,:120;
//     notifications/intake.ts:280→:366; rule-findings.ts:1544→:1578 (this change).
//   own unbounded MIN(l.date), hand-built — usual-routine.ts:249→:273. Correct: it
//     draws no window, so it has nothing to union the lifetime half against.
//   getIntakeLogsInRange — sleep.ts:423→:466, and NOT an instance of this defect: its
//     index answers only window-local taken/skipped questions and its bound is
//     `doseExistsSince`, the UN-widened one, by the deliberate #1972/#1973 rule that a
//     logged night renders on the strength of its log alone. Whether that bound should
//     widen too is a question about bedtime history, filed rather than settled here.
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
    // WHAT THIS CANNOT SEE, measured rather than guessed: the assertion reads the
    // bound through a Friday COUNT, and every bound older than the 56-day drawn window
    // yields the same count. Shifting the production bound forward +30, +44 and +50
    // days all pass; +51 fails, because that is where it crosses into the window. So
    // the guard is blind by up to ~50 days — which is exactly the region #4020 is
    // about. It catches #4020's own regression (the bound collapsing to `created_at`)
    // and does not defend the property in general.
    expect(finding?.detail).toContain(
      `${fridaysInStripWindow} of the last ${fridaysInStripWindow}`
    );
  });
});
