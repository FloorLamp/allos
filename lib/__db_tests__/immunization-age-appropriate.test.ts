// DB INTEGRATION TIER — age-appropriate immunization status (issue #552), through
// the SAME age resolution the page + Upcoming generator use (getImmunizations +
// profileAgeMonths + getUserSex → assessSchedule). The pure engine is covered in
// lib/__tests__/immunization-status.test.ts; this pins the end-to-end wiring on a
// seeded profile per the #448 convention: an adult with no rotavirus record reads
// `not_recommended` (age-inappropriate), NOT `unknown`; a child missing MMR still
// reads `overdue`; an adult missing Tdap still reads `unknown`.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { getImmunizations, getImmunityTiters } from "@/lib/queries";
import {
  setUserBirthdate,
  setUserSex,
  profileAgeMonths,
  getUserSex,
} from "@/lib/settings";
import { assessSchedule } from "@/lib/immunization-status";
import { shiftDateStr } from "@/lib/date";

function makeProfile(name: string, birthdate: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setUserBirthdate(id, birthdate);
  setUserSex(id, "female");
  return id;
}

// Resolve the per-vaccine status the page renders, exactly as the page/generator
// build it (age from the profile's DOB, this profile's records + titers).
function statusFor(profileId: number, code: string, now: string): string {
  const summary = assessSchedule(
    getImmunizations(profileId).map((r) => ({
      vaccine: r.vaccine,
      date: r.date,
    })),
    profileAgeMonths(profileId, now),
    getUserSex(profileId),
    now,
    getImmunityTiters(profileId).map((t) => ({
      marker: t.marker,
      status: t.status,
    }))
  );
  return summary.assessments.find((a) => a.code === code)!.status;
}

describe("issue #552 — age-appropriate immunization status via the profile's age", () => {
  it("an adult with no rotavirus / childhood-PCV record reads not_recommended, not unknown", () => {
    const now = today(1);
    // Born ~40 years ago; no immunization records at all.
    const pid = makeProfile("Adult No Records", shiftDateStr(now, -40 * 365));
    expect(statusFor(pid, "rv", now)).toBe("not_recommended");
    expect(statusFor(pid, "pcv", now)).toBe("not_recommended");
    // A series WITH an adult catch-up stays unknown for the same adult.
    expect(statusFor(pid, "mmr", now)).toBe("unknown");
    expect(statusFor(pid, "tdap", now)).toBe("unknown");
  });

  it("a child missing MMR still reads overdue (the gate is adulthood-only)", () => {
    const now = today(1);
    // Born ~3 years ago (36 months): past the 12-month MMR dose-1 age with no
    // record → a real, surfaced gap.
    const pid = makeProfile("Toddler", shiftDateStr(now, -3 * 365));
    expect(statusFor(pid, "mmr", now)).toBe("overdue");
    // The infant-only series are likewise still overdue for the child, not N/A.
    expect(statusFor(pid, "rv", now)).toBe("overdue");
  });
});
