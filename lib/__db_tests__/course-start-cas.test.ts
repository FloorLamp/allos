// DB INTEGRATION TIER — a backdated administration whose course correction MISSES
// (#4909).
//
// `setCourseStartDate` is a compare-and-set, and its CAS carries one predicate the
// two historical-dose cores' own course reads do not: `kind = 'medication'`. Those
// cores are deliberately kind-neutral (#1933) and read a course by (item, profile)
// alone, so the two predicates can disagree — and while the outcome was discarded, a
// disagreement committed the administration with the start left where it was, under a
// form that had just said "start date will move back to match".
//
// The state is reachable through the shipped UI, not only through raw SQL: the edit
// form writes `kind`, so a medication can be saved as a supplement, and NOTHING in
// the tree ever deletes a medication_courses row (`git grep "DELETE FROM
// medication_courses" -- lib/ app/` outside the test tiers returns nothing), so its
// courses outlive the change. The fixture reproduces that by flipping the column the
// same way the form does.
//
// Each case asserts BOTH halves — the refusal and the absence of the write — because
// the defect was precisely a refusal that was not one. The medication row is the
// non-vacuity control: same fixture, same call, CAS applies, start moves.

import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr, zonedWallTimeToUtc } from "@/lib/date";
import { getTimezone } from "@/lib/settings";
import { logHistoricalDose, updateHistoricalDose } from "@/lib/queries";
import type { IntakeItemKind } from "@/lib/types";

let unique = 0;

function newProfile(): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(`csc${++unique}`)
      .lastInsertRowid
  );
}

// A PRN item with ONE open course that starts after the day the test backdates to,
// so the historical write has a course to extend backward. `kind` is written last,
// exactly as the edit form writes it, so a "supplement" here is a medication that
// was saved as one and kept its course.
function seedPrnWithCourse(
  profileId: number,
  kind: IntakeItemKind,
  startedOn: string
): { itemId: number; doseId: number; courseId: number } {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation,
            quantity_on_hand, qty_per_dose)
         VALUES (?, ?, 1, 'medication', 'daily', 'may', 20, 1)`
      )
      .run(profileId, `Course CAS Item ${++unique}`).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '200 mg', 'Anytime', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  const courseId = Number(
    db
      .prepare(
        `INSERT INTO medication_courses (item_id, started_on, stopped_on)
         VALUES (?, ?, NULL)`
      )
      .run(itemId, startedOn).lastInsertRowid
  );
  db.prepare("UPDATE intake_items SET kind = ? WHERE id = ?").run(kind, itemId);
  return { itemId, doseId, courseId };
}

function courseStart(courseId: number): string | null {
  return (
    db
      .prepare("SELECT started_on FROM medication_courses WHERE id = ?")
      .get(courseId) as { started_on: string | null }
  ).started_on;
}

function ledgerCount(itemId: number, date: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM intake_item_logs WHERE item_id = ? AND date = ?"
      )
      .get(itemId, date) as { n: number }
  ).n;
}

describe("a backdated administration whose course correction cannot apply", () => {
  // "medication" is the control: it is the shape every e2e fixture and every
  // shipped add path produces, and it must still log and still move the start.
  it.each<[IntakeItemKind, "logged" | "outside-course"]>([
    ["medication", "logged"],
    ["supplement", "outside-course"],
  ])("logHistoricalDose on a %s answers %s", (kind, expected) => {
    const p = newProfile();
    const backdated = shiftDateStr(today(p), -45);
    const seededStart = shiftDateStr(today(p), -5);
    const { itemId, doseId, courseId } = seedPrnWithCourse(
      p,
      kind,
      seededStart
    );

    const outcome = logHistoricalDose(
      p,
      itemId,
      doseId,
      zonedWallTimeToUtc(getTimezone(p), backdated, "03:17")!,
      "200 mg",
      false,
      "page"
    );

    if (expected === "logged") {
      expect(outcome).toEqual({ kind: "logged", date: backdated });
      expect(courseStart(courseId)).toBe(backdated);
      expect(ledgerCount(itemId, backdated)).toBe(1);
    } else {
      expect(outcome).toEqual({ kind: "outside-course" });
      // The whole intent is aborted, not half of it: the start is untouched AND
      // the administration never landed.
      expect(courseStart(courseId)).toBe(seededStart);
      expect(ledgerCount(itemId, backdated)).toBe(0);
    }
  });

  it.each<[IntakeItemKind, "logged" | "outside-course"]>([
    ["medication", "logged"],
    ["supplement", "outside-course"],
  ])("updateHistoricalDose on a %s answers %s", (kind, expected) => {
    const p = newProfile();
    const backdated = shiftDateStr(today(p), -45);
    const seededStart = shiftDateStr(today(p), -5);
    const insideCourse = shiftDateStr(today(p), -2);
    const { itemId, doseId, courseId } = seedPrnWithCourse(
      p,
      kind,
      seededStart
    );
    const logId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_logs (dose_id, item_id, date, amount, recorded_at, status)
           VALUES (?, ?, ?, '200 mg', ?, 'taken')`
        )
        .run(doseId, itemId, insideCourse, `${insideCourse} 09:00:00`)
        .lastInsertRowid
    );

    // A date-only amendment: it states no instant, so there is nothing for the
    // pair rule to disagree with and the course question is the only one left.
    const outcome = updateHistoricalDose(
      p,
      itemId,
      logId,
      backdated,
      null,
      null
    );

    if (expected === "logged") {
      expect(outcome).toEqual({ kind: "logged", date: backdated });
      expect(courseStart(courseId)).toBe(backdated);
    } else {
      expect(outcome).toEqual({ kind: "outside-course" });
      expect(courseStart(courseId)).toBe(seededStart);
      // The ledger row stayed on the day it was already on.
      expect(ledgerCount(itemId, backdated)).toBe(0);
      expect(ledgerCount(itemId, insideCourse)).toBe(1);
    }
  });
});
