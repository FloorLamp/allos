// DB INTEGRATION TIER (issue #1098). getInferredPreventiveSatisfactions now folds a
// dated optical_prescriptions row into the preventive satisfaction stream: a new
// eyeglass/contact Rx is written AT an eye exam, so the row satisfies the vision_exam
// rule as of its issued date. The pure source is unit-tested in lib/__tests__; this
// exercises the real GATHER — the profile-scoped optical read, the direct source, and
// the merge into the ONE assessor every surface (Upcoming, the nudge) consumes. Pins
// the acceptance end-to-end: a recent Rx clears the due eye-exam item; an old Rx
// outside the window does not; the satisfaction date is the Rx's ISSUED date.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { setUserBirthdate, setUserSex } from "@/lib/settings";
import {
  collectUpcoming,
  getInferredPreventiveSatisfactions,
} from "@/lib/queries";

// A ~46-year-old: well past the vision_exam entry age (3), so with no history the
// eye exam is due — the clean canvas the Rx source acts on.
function makeProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setUserBirthdate(id, "1980-01-01");
  setUserSex(id, "male");
  return id;
}

function addOpticalRx(p: number, issuedDate: string | null): void {
  db.prepare(
    `INSERT INTO optical_prescriptions
       (profile_id, kind, od_sphere, os_sphere, issued_date, source)
     VALUES (?, 'glasses', -1.25, -1.5, ?, 'manual')`
  ).run(p, issuedDate);
}

function visionDue(p: number, now: string): boolean {
  return collectUpcoming(p, now).some((i) => i.key === "visit:vision_exam");
}

// Shift a YYYY-MM-DD date back by whole years (stays a valid past date).
function yearsAgo(date: string, n: number): string {
  const [y, rest] = [date.slice(0, 4), date.slice(4)];
  return `${Number(y) - n}${rest}`;
}

describe("preventive optical-Rx gather (#1098)", () => {
  it("a recent optical Rx clears the due eye-exam item and satisfies as of its issued date", () => {
    const p = makeProfile("Optical Rx Recent");
    const now = today(p);
    // Control: no vision history → the eye exam is due.
    expect(visionDue(p, now)).toBe(true);

    const issued = yearsAgo(now, 1); // within the ~24-month interval
    addOpticalRx(p, issued);

    // The gather emits a vision_exam satisfaction dated to the Rx's ISSUED date...
    expect(getInferredPreventiveSatisfactions(p)).toContainEqual({
      ruleKey: "vision_exam",
      date: issued,
    });
    // ...and the eye-exam item is no longer due.
    expect(visionDue(p, now)).toBe(false);
  });

  it("an OLD Rx outside the interval satisfies only as of its old date — the exam stays due", () => {
    const p = makeProfile("Optical Rx Stale");
    const now = today(p);
    const issued = yearsAgo(now, 6); // well beyond the ~24-month interval + grace

    addOpticalRx(p, issued);

    // The satisfaction is still emitted (dated to the old Rx)...
    expect(getInferredPreventiveSatisfactions(p)).toContainEqual({
      ruleKey: "vision_exam",
      date: issued,
    });
    // ...but a stale Rx does NOT suppress a genuinely-due exam.
    expect(visionDue(p, now)).toBe(true);
  });

  it("an undated Rx contributes no satisfaction (can't be placed on the timeline)", () => {
    const p = makeProfile("Optical Rx Undated");
    const now = today(p);
    addOpticalRx(p, null);

    expect(
      getInferredPreventiveSatisfactions(p).some(
        (s) => s.ruleKey === "vision_exam"
      )
    ).toBe(false);
    expect(visionDue(p, now)).toBe(true);
  });
});
