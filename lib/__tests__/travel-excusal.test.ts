import { describe, expect, it } from "vitest";
import { isDoseSlotExcused, windowSlotMinute } from "@/lib/travel-excusal";
import { DEFAULT_INTAKE_REMINDER_MINUTES } from "@/lib/notifications/schedule";
import {
  resolveSwitchHistory,
  type TimezoneSwitch,
} from "@/lib/travel-timezone";

// New York 10:00 → Tokyo 23:00, both on 2026-05-01: the wall clock between them
// never occurred, so Midday (13:00), Evening (20:00) and Bedtime (22:00) all sit
// inside the skipped span and Morning (08:00) does not.
const FLIGHT: TimezoneSwitch = {
  at: "2026-05-01T14:00:00Z",
  from: "America/New_York",
  to: "Asia/Tokyo",
};
const DAY = "2026-05-01";

const DEFAULT_SLOTS = {
  Morning: DEFAULT_INTAKE_REMINDER_MINUTES.Morning,
  Midday: DEFAULT_INTAKE_REMINDER_MINUTES.Midday,
  Evening: DEFAULT_INTAKE_REMINDER_MINUTES.Evening,
  Bedtime: DEFAULT_INTAKE_REMINDER_MINUTES.Bedtime,
};

describe("windowSlotMinute", () => {
  it("uses the profile's configured time for the window", () => {
    expect(windowSlotMinute("Evening", 19 * 60 + 30)).toBe(19 * 60 + 30);
  });

  it("falls back to the shipped default when the window is switched off", () => {
    // Turning a reminder off does not move when the dose is meant to be taken, so
    // the denominator keeps judging it at its nominal hour.
    expect(windowSlotMinute("Evening", null)).toBe(
      DEFAULT_INTAKE_REMINDER_MINUTES.Evening
    );
  });
});

describe("isDoseSlotExcused", () => {
  it("excuses a bucketed dose whose hour the switch jumped over", () => {
    for (const bucket of ["Midday", "Evening", "Before sleep"] as const) {
      expect(isDoseSlotExcused(resolveSwitchHistory([FLIGHT]), DEFAULT_SLOTS, bucket, DAY)).toBe(
        true
      );
    }
  });

  it("leaves a dose whose hour happened before the jump alone", () => {
    expect(isDoseSlotExcused(resolveSwitchHistory([FLIGHT]), DEFAULT_SLOTS, "Morning", DAY)).toBe(
      false
    );
  });

  it("NEVER excuses an Anytime dose", () => {
    // Its window is the whole day, so a skipped stretch of wall clock makes it late,
    // not impossible. Excusing it would drop from the denominator a dose the person
    // could still have taken and was never asked about — the same error the other
    // way round.
    expect(isDoseSlotExcused(resolveSwitchHistory([FLIGHT]), DEFAULT_SLOTS, "Anytime", DAY)).toBe(
      false
    );
  });

  it("follows the profile's own configured time, not the default", () => {
    // Move the evening reminder to 09:30 — before the jump — and the same flight no
    // longer excuses it. One number decides both the send and the denominator, so
    // this is also what stops the two disagreeing.
    const early = { ...DEFAULT_SLOTS, Evening: 9 * 60 + 30 };
    expect(isDoseSlotExcused(resolveSwitchHistory([FLIGHT]), early, "Evening", DAY)).toBe(false);
  });

  it("excuses nothing on another day, or with no switches at all", () => {
    expect(
      isDoseSlotExcused(resolveSwitchHistory([FLIGHT]), DEFAULT_SLOTS, "Evening", "2026-05-02")
    ).toBe(false);
    expect(isDoseSlotExcused(resolveSwitchHistory([]), DEFAULT_SLOTS, "Evening", DAY)).toBe(false);
  });
});
