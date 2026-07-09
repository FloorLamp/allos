// DB INTEGRATION TIER (issue #213, Phase 2). Two features against a real
// (in-memory) SQLite handle:
//   1. Appointments: the queries are profile-scoped (no cross-profile bleed), the
//      scheduled/settled split is right, and a scheduled visit surfaces in
//      collectUpcoming banded by its date while completed/cancelled ones don't.
//   2. Per-biomarker retest cadence: a reading older than its curated cadence
//      surfaces as an Upcoming retest even when it's well under a year, while an
//      annual-cadence marker of the same age does not.
// The static source scan (lib/__tests__/profile-scoping.test.ts) can't see across
// the helper calls; this is the dynamic guard.

import { describe, it, expect, beforeAll } from "vitest";
import { db, today } from "@/lib/db";
import {
  getAppointments,
  getScheduledAppointments,
  collectUpcoming,
} from "@/lib/queries";
import { shiftDateStr } from "@/lib/date";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function addAppointment(
  profileId: number,
  scheduledAt: string,
  title: string,
  status = "scheduled"
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO appointments (profile_id, scheduled_at, title, status)
         VALUES (?, ?, ?, ?)`
      )
      .run(profileId, scheduledAt, title, status).lastInsertRowid
  );
}

describe("appointments — profile scoping + Upcoming surfacing", () => {
  let pa: number;
  let pb: number;
  let now: string;

  beforeAll(() => {
    pa = newProfile("APPT-A");
    pb = newProfile("APPT-B");
    now = today(pa);
    // Profile A: a future scheduled visit, a past-and-still-scheduled visit, and a
    // completed one (settled).
    addAppointment(pa, shiftDateStr(now, 3), "AAA Dermatology");
    addAppointment(pa, shiftDateStr(now, -5), "AAA Missed physical");
    addAppointment(pa, shiftDateStr(now, -30), "AAA Done visit", "completed");
    // Profile B: its own visit, tagged, to prove no bleed.
    addAppointment(pb, shiftDateStr(now, 2), "BBB Cardiology");
  });

  it("getAppointments returns only the querying profile's rows", () => {
    const a = getAppointments(pa);
    expect(a).toHaveLength(3);
    expect(a.every((r) => r.title?.startsWith("AAA"))).toBe(true);
    expect(a.some((r) => r.title?.includes("BBB"))).toBe(false);

    const b = getAppointments(pb);
    expect(b).toHaveLength(1);
    expect(b[0].title).toBe("BBB Cardiology");
  });

  it("getScheduledAppointments drops completed/cancelled rows", () => {
    const scheduled = getScheduledAppointments(pa);
    expect(scheduled.map((r) => r.title)).toEqual([
      "AAA Missed physical", // soonest-first: the past one sorts before the future one
      "AAA Dermatology",
    ]);
  });

  it("surfaces scheduled appointments in collectUpcoming, banded by date", () => {
    const items = collectUpcoming(pa, now);
    const appts = items.filter((i) => i.domain === "appointment");
    expect(appts.map((i) => i.title).sort()).toEqual([
      "AAA Dermatology",
      "AAA Missed physical",
    ]);
    // The past-and-still-scheduled visit is overdue; the future one is not.
    const missed = appts.find((i) => i.title === "AAA Missed physical")!;
    expect(missed.dueDate! < now).toBe(true);
    // Completed visit never surfaces.
    expect(appts.some((i) => i.title === "AAA Done visit")).toBe(false);
  });

  it("collectUpcoming never leaks another profile's appointment", () => {
    const items = collectUpcoming(pa, now);
    expect(items.some((i) => i.title.includes("BBB"))).toBe(false);
  });
});

describe("per-biomarker retest cadence surfacing", () => {
  let profileId: number;
  let now: string;

  beforeAll(() => {
    profileId = newProfile("RETEST");
    now = today(profileId);
    // An HbA1c read 120 days ago: past its curated 90-day cadence, but far under a
    // year — it would NOT surface under the old flat 365-day rule.
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, unit, canonical_name, value_num, panel)
       VALUES (?, ?, 'lab', 'Hemoglobin A1c', '5.4', '%', 'Hemoglobin A1c', 5.4, 'Metabolic')`
    ).run(profileId, shiftDateStr(now, -120));
    // An LDL read the same 120 days ago: its cadence is annual (365), so it must
    // NOT surface yet.
    db.prepare(
      `INSERT INTO medical_records
         (profile_id, date, category, name, value, unit, canonical_name, value_num, panel)
       VALUES (?, ?, 'lab', 'LDL Cholesterol', '100', 'mg/dL', 'LDL Cholesterol', 100, 'Lipids')`
    ).run(profileId, shiftDateStr(now, -120));
  });

  it("surfaces a short-cadence marker sooner than the flat 365-day rule", () => {
    const items = collectUpcoming(profileId, now);
    const bios = items.filter((i) => i.domain === "biomarker");
    const names = bios.map((i) => i.title);
    expect(names).toContain("Hemoglobin A1c");
    // The annual LDL of the same age is not yet due.
    expect(names).not.toContain("LDL Cholesterol");
  });

  it("describes the per-analyte cadence in the due-text", () => {
    const items = collectUpcoming(profileId, now);
    const a1c = items.find((i) => i.title === "Hemoglobin A1c")!;
    // 90 days ≈ 3 months.
    expect(a1c.detail).toContain("retest every 3mo");
  });
});
