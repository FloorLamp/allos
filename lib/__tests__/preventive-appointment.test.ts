import { describe, expect, it } from "vitest";
import {
  APPOINTMENT_KINDS,
  appointmentKindForRule,
  isAppointmentKind,
  satisfiedRuleForCompletedKind,
  scheduledMatchForRule,
  suggestedBookDate,
  type KindedAppointment,
} from "../preventive-appointment";
import { PREVENTIVE_CATALOG } from "../preventive-catalog";

// Pure matching logic between preventive rules and booked appointments (issue #85).

describe("isAppointmentKind", () => {
  it("accepts the known kinds and rejects everything else", () => {
    for (const k of APPOINTMENT_KINDS) expect(isAppointmentKind(k)).toBe(true);
    expect(isAppointmentKind(null)).toBe(false);
    expect(isAppointmentKind("")).toBe(false);
    expect(isAppointmentKind("Physical")).toBe(false); // case-sensitive
    expect(isAppointmentKind("colonoscopy")).toBe(false);
  });
});

describe("appointmentKindForRule", () => {
  it("maps the clean 1:1 visit rules", () => {
    expect(appointmentKindForRule("adult_physical")).toBe("physical");
    expect(appointmentKindForRule("dental_cleaning")).toBe("dental");
    expect(appointmentKindForRule("vision_exam")).toBe("vision");
  });

  it("maps every well-child rule to well_child", () => {
    expect(appointmentKindForRule("wellchild_2mo")).toBe("well_child");
    expect(appointmentKindForRule("wellchild_annual")).toBe("well_child");
  });

  it("maps screenings (and skin_check) to the generic screening kind", () => {
    expect(appointmentKindForRule("colorectal_cancer")).toBe("screening");
    expect(appointmentKindForRule("mammography")).toBe("screening");
    expect(appointmentKindForRule("skin_check")).toBe("screening");
  });

  it("returns a valid kind for every catalog rule (total mapping)", () => {
    for (const rule of PREVENTIVE_CATALOG) {
      const kind = appointmentKindForRule(rule.key);
      expect(kind).not.toBeNull();
      expect(APPOINTMENT_KINDS).toContain(kind);
    }
  });

  it("returns null for an unknown rule key", () => {
    expect(appointmentKindForRule("not_a_rule")).toBeNull();
  });
});

describe("satisfiedRuleForCompletedKind", () => {
  it("maps only the unambiguous single-rule kinds", () => {
    expect(satisfiedRuleForCompletedKind("physical")).toBe("adult_physical");
    expect(satisfiedRuleForCompletedKind("dental")).toBe("dental_cleaning");
    expect(satisfiedRuleForCompletedKind("vision")).toBe("vision_exam");
  });

  it("does not map the ambiguous or non-preventive kinds", () => {
    expect(satisfiedRuleForCompletedKind("well_child")).toBeNull();
    expect(satisfiedRuleForCompletedKind("screening")).toBeNull();
    expect(satisfiedRuleForCompletedKind("other")).toBeNull();
    expect(satisfiedRuleForCompletedKind(null)).toBeNull();
    expect(satisfiedRuleForCompletedKind("garbage")).toBeNull();
  });

  it("round-trips: its rule maps back to the same kind", () => {
    for (const kind of ["physical", "dental", "vision"] as const) {
      const ruleKey = satisfiedRuleForCompletedKind(kind)!;
      expect(appointmentKindForRule(ruleKey)).toBe(kind);
    }
  });
});

describe("scheduledMatchForRule", () => {
  const appt = (over: Partial<KindedAppointment>): KindedAppointment => ({
    kind: "physical",
    scheduledAt: "2026-08-01",
    status: "scheduled",
    ...over,
  });

  it("matches a future scheduled appointment of the rule's kind", () => {
    const appts = [appt({ kind: "physical", scheduledAt: "2026-08-01" })];
    expect(scheduledMatchForRule("adult_physical", appts, "2026-07-10")).toBe(
      "2026-08-01"
    );
  });

  it("matches a datetime-valued appointment by its calendar day", () => {
    const appts = [appt({ scheduledAt: "2026-08-01 09:30" })];
    expect(scheduledMatchForRule("adult_physical", appts, "2026-07-10")).toBe(
      "2026-08-01"
    );
  });

  it("returns the soonest of several matches", () => {
    const appts = [
      appt({ scheduledAt: "2026-09-01" }),
      appt({ scheduledAt: "2026-08-15" }),
      appt({ scheduledAt: "2026-08-20" }),
    ];
    expect(scheduledMatchForRule("adult_physical", appts, "2026-07-10")).toBe(
      "2026-08-15"
    );
  });

  it("never matches a NULL-kind appointment (no fuzzy guessing)", () => {
    const appts = [appt({ kind: null })];
    expect(
      scheduledMatchForRule("adult_physical", appts, "2026-07-10")
    ).toBeNull();
  });

  it("does not match a different kind", () => {
    const appts = [appt({ kind: "dental" })];
    expect(
      scheduledMatchForRule("adult_physical", appts, "2026-07-10")
    ).toBeNull();
  });

  it("ignores past-dated and non-scheduled appointments", () => {
    const appts = [
      appt({ scheduledAt: "2026-07-01" }), // past
      appt({ scheduledAt: "2026-08-01", status: "completed" }),
      appt({ scheduledAt: "2026-08-01", status: "cancelled" }),
    ];
    expect(
      scheduledMatchForRule("adult_physical", appts, "2026-07-10")
    ).toBeNull();
  });

  it("treats a today-dated scheduled appointment as a match", () => {
    const appts = [appt({ scheduledAt: "2026-07-10" })];
    expect(scheduledMatchForRule("adult_physical", appts, "2026-07-10")).toBe(
      "2026-07-10"
    );
  });

  it("matches any screening rule from a generic screening booking (coarse bucket)", () => {
    const appts = [appt({ kind: "screening", scheduledAt: "2026-08-01" })];
    expect(scheduledMatchForRule("hepatitis_c", appts, "2026-07-10")).toBe(
      "2026-08-01"
    );
    expect(scheduledMatchForRule("skin_check", appts, "2026-07-10")).toBe(
      "2026-08-01"
    );
  });

  it("returns null for an unknown rule key", () => {
    const appts = [appt({})];
    expect(scheduledMatchForRule("not_a_rule", appts, "2026-07-10")).toBeNull();
  });
});

describe("suggestedBookDate", () => {
  it("uses a future next-due date", () => {
    expect(suggestedBookDate("2026-09-01", "2026-07-10")).toBe("2026-09-01");
  });

  it("falls back to today for a past or missing next-due date", () => {
    expect(suggestedBookDate("2026-06-01", "2026-07-10")).toBe("2026-07-10");
    expect(suggestedBookDate("2026-07-10", "2026-07-10")).toBe("2026-07-10");
    expect(suggestedBookDate(null, "2026-07-10")).toBe("2026-07-10");
  });
});
