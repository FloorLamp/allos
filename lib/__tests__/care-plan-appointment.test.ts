// Pure matcher between a completed appointment and open care-plan items (issue
// #658) — the confirm-first close-the-loop offer's brain. No DB.

import { describe, it, expect } from "vitest";
import {
  matchCarePlanItemsForAppointment,
  appointmentMatchNeedles,
  CARE_PLAN_MATCH_WINDOW_DAYS,
  type CarePlanMatchItem,
} from "../care-plan-appointment";

const VISIT = "2026-03-15";

function item(over: Partial<CarePlanMatchItem>): CarePlanMatchItem {
  return {
    id: 1,
    description: "Colonoscopy screening",
    code: null,
    planned_date: VISIT,
    status: "planned",
    ...over,
  };
}

describe("appointmentMatchNeedles", () => {
  it("keeps meaningful title words and drops generic filler", () => {
    const needles = appointmentMatchNeedles({
      kind: null,
      title: "Colonoscopy screening visit",
      notes: null,
      scheduledAt: VISIT,
    });
    expect(needles).toContain("colonoscopy");
    expect(needles).toContain("screening");
    // "visit" is generic filler; short words never survive.
    expect(needles).not.toContain("visit");
  });

  it("adds curated keywords for kinds even with no title", () => {
    expect(
      appointmentMatchNeedles({
        kind: "dental",
        title: null,
        notes: null,
        scheduledAt: VISIT,
      })
    ).toContain("dental");
    // vision contributes the too-short-to-tokenize "eye".
    expect(
      appointmentMatchNeedles({
        kind: "vision",
        title: null,
        notes: null,
        scheduledAt: VISIT,
      })
    ).toContain("eye");
  });

  it("needles nothing for a bare screening appointment (coarse kind)", () => {
    expect(
      appointmentMatchNeedles({
        kind: "screening",
        title: null,
        notes: null,
        scheduledAt: VISIT,
      })
    ).toEqual([]);
  });
});

describe("matchCarePlanItemsForAppointment", () => {
  const appt = {
    kind: "screening" as const,
    title: "Colonoscopy",
    notes: null,
    scheduledAt: VISIT,
  };

  it("matches an open item whose description shares a needle in-window", () => {
    const matched = matchCarePlanItemsForAppointment(appt, [item({})]);
    expect(matched.map((m) => m.id)).toEqual([1]);
  });

  it("skips closed items (completed / cancelled)", () => {
    const matched = matchCarePlanItemsForAppointment(appt, [
      item({ id: 2, status: "completed" }),
      item({ id: 3, status: "cancelled" }),
    ]);
    expect(matched).toEqual([]);
  });

  it("skips items whose description shares no needle", () => {
    const matched = matchCarePlanItemsForAppointment(appt, [
      item({ id: 4, description: "Annual eye exam" }),
    ]);
    expect(matched).toEqual([]);
  });

  it("respects the date window but always admits undated items", () => {
    const farFuture = matchCarePlanItemsForAppointment(appt, [
      item({ id: 5, planned_date: "2028-01-01" }),
    ]);
    expect(farFuture).toEqual([]);

    const undated = matchCarePlanItemsForAppointment(appt, [
      item({ id: 6, planned_date: null }),
    ]);
    expect(undated.map((m) => m.id)).toEqual([6]);

    // A date just inside the window still matches.
    const near = matchCarePlanItemsForAppointment(appt, [
      item({
        id: 7,
        planned_date: "2026-06-01", // ~78 days out, < window
      }),
    ]);
    expect(near.map((m) => m.id)).toEqual([7]);
    expect(CARE_PLAN_MATCH_WINDOW_DAYS).toBeGreaterThan(78);
  });

  it("matches a dental kind against a 'Dental cleaning' item with no appt title", () => {
    const matched = matchCarePlanItemsForAppointment(
      { kind: "dental", title: null, notes: null, scheduledAt: VISIT },
      [item({ id: 8, description: "Dental cleaning" })]
    );
    expect(matched.map((m) => m.id)).toEqual([8]);
  });

  it("returns nothing when the appointment needles nothing", () => {
    const matched = matchCarePlanItemsForAppointment(
      { kind: "screening", title: null, notes: null, scheduledAt: VISIT },
      [item({})]
    );
    expect(matched).toEqual([]);
  });
});
