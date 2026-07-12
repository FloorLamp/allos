import { describe, expect, it } from "vitest";
import {
  matchAppointmentForEncounter,
  type MatchAppointment,
} from "@/lib/appointment-encounter-match";

// A scheduled, unlinked appointment on 2026-03-10 with provider 7.
function appt(over: Partial<MatchAppointment> = {}): MatchAppointment {
  return {
    id: 1,
    scheduledAt: "2026-03-10",
    providerId: 7,
    status: "scheduled",
    encounterId: null,
    ...over,
  };
}

describe("matchAppointmentForEncounter (#288)", () => {
  it("matches a single same-day, same-provider scheduled appointment", () => {
    expect(
      matchAppointmentForEncounter({ date: "2026-03-10", providerId: 7 }, [
        appt({ id: 42 }),
      ])
    ).toBe(42);
  });

  it("matches when the appointment carries a time and the encounter is date-only", () => {
    expect(
      matchAppointmentForEncounter({ date: "2026-03-10", providerId: 7 }, [
        appt({ id: 42, scheduledAt: "2026-03-10 09:30" }),
      ])
    ).toBe(42);
  });

  it("does not match when the encounter has no provider (conservative)", () => {
    expect(
      matchAppointmentForEncounter({ date: "2026-03-10", providerId: null }, [
        appt(),
      ])
    ).toBeNull();
  });

  it("does not match a same-day appointment with a different provider", () => {
    expect(
      matchAppointmentForEncounter({ date: "2026-03-10", providerId: 7 }, [
        appt({ providerId: 9 }),
      ])
    ).toBeNull();
  });

  it("does not match an appointment with a null provider", () => {
    expect(
      matchAppointmentForEncounter({ date: "2026-03-10", providerId: 7 }, [
        appt({ providerId: null }),
      ])
    ).toBeNull();
  });

  it("does not match a different calendar day", () => {
    expect(
      matchAppointmentForEncounter({ date: "2026-03-11", providerId: 7 }, [
        appt(),
      ])
    ).toBeNull();
  });

  it("ignores non-scheduled and already-linked appointments", () => {
    expect(
      matchAppointmentForEncounter({ date: "2026-03-10", providerId: 7 }, [
        appt({ id: 1, status: "completed" }),
        appt({ id: 2, status: "cancelled" }),
        appt({ id: 3, encounterId: 500 }),
      ])
    ).toBeNull();
  });

  it("with two same-day candidates and a timed encounter, picks the nearest time", () => {
    const id = matchAppointmentForEncounter(
      { date: "2026-03-10 10:00", providerId: 7 },
      [
        appt({ id: 1, scheduledAt: "2026-03-10 09:45" }),
        appt({ id: 2, scheduledAt: "2026-03-10 14:00" }),
      ]
    );
    expect(id).toBe(1);
  });

  it("with two equidistant candidates, refuses to guess (tie = no match)", () => {
    expect(
      matchAppointmentForEncounter(
        { date: "2026-03-10 10:00", providerId: 7 },
        [
          appt({ id: 1, scheduledAt: "2026-03-10 09:00" }),
          appt({ id: 2, scheduledAt: "2026-03-10 11:00" }),
        ]
      )
    ).toBeNull();
  });

  it("with two candidates but no time signal, refuses to guess", () => {
    expect(
      matchAppointmentForEncounter({ date: "2026-03-10", providerId: 7 }, [
        appt({ id: 1 }),
        appt({ id: 2 }),
      ])
    ).toBeNull();
  });
});
