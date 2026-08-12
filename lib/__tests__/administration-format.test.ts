import { describe, it, expect } from "vitest";
import {
  formatGivenAtClock,
  formatGivenAtClockWithRelativeAge,
  formatGivenAtNoticeTime,
  administrationDayLabel,
  administrationLastDoseLabel,
  administrationOutcomeText,
  administrationLogged,
} from "@/lib/administration-format";
import {
  isDoseDateAccepted,
  isGivenAtAccepted,
  isHistoricalDoseTimeAccepted,
  resolveQueuedTakenAt,
  DOSE_LOG_DATE_WINDOW_DAYS,
} from "@/lib/dose-log-window";
import type { AdministrationOutcome } from "@/lib/types";

describe("formatGivenAtClock", () => {
  it("renders a stored UTC datetime in the profile's local 12-hour clock", () => {
    // 2026-07-15 20:02 UTC → 16:02 in New York (EDT, −4) → "4:02pm".
    expect(formatGivenAtClock("America/New_York", "2026-07-15 20:02:00")).toBe(
      "4:02pm"
    );
    // Midnight UTC → 12:00 AM UTC.
    expect(formatGivenAtClock("UTC", "2026-07-15 00:00:00")).toBe("12:00am");
    // Noon UTC → 12:00 PM.
    expect(formatGivenAtClock("UTC", "2026-07-15 12:00:00")).toBe("12:00pm");
  });
  it("renders a 24-hour clock when the login prefers it (#964)", () => {
    expect(
      formatGivenAtClock("America/New_York", "2026-07-15 20:02:00", "24h")
    ).toBe("16:02");
    expect(formatGivenAtClock("UTC", "2026-07-15 00:00:00", "24h")).toBe(
      "00:00"
    );
    expect(formatGivenAtClock("UTC", "2026-07-15 12:00:00", "24h")).toBe(
      "12:00"
    );
  });
  it("returns empty string for a missing/garbage value", () => {
    expect(formatGivenAtClock("UTC", null)).toBe("");
    expect(formatGivenAtClock("UTC", "not-a-date")).toBe("");
  });
});

describe("formatGivenAtClockWithRelativeAge", () => {
  const now = new Date("2026-07-15T22:02:00Z");

  it("adds relative age in parentheses for the profile's current day", () => {
    expect(
      formatGivenAtClockWithRelativeAge(
        "America/New_York",
        "2026-07-15 20:02:00",
        "12h",
        now
      )
    ).toBe("4:02pm (2 hrs ago)");
  });

  it("keeps an older day's time as a plain clock", () => {
    expect(
      formatGivenAtClockWithRelativeAge(
        "America/New_York",
        "2026-07-14 20:02:00",
        "12h",
        now
      )
    ).toBe("4:02pm");
  });

  it("respects 24-hour time", () => {
    expect(
      formatGivenAtClockWithRelativeAge(
        "America/New_York",
        "2026-07-15 20:02:00",
        "24h",
        now
      )
    ).toBe("16:02 (2 hrs ago)");
  });
});

describe("formatGivenAtNoticeTime", () => {
  it("adds the date when the arming administration was not today", () => {
    expect(
      formatGivenAtNoticeTime(
        "America/New_York",
        "2026-07-14 20:02:00",
        "2026-07-15"
      )
    ).toBe("Jul 14, 2026 at 4:02pm");
    expect(
      formatGivenAtNoticeTime(
        "America/New_York",
        "2026-07-15 20:02:00",
        "2026-07-15"
      )
    ).toBe("4:02pm");
  });
});

describe("administrationDayLabel", () => {
  it("summarizes the day's administrations", () => {
    expect(administrationDayLabel(0, "")).toBe("None today");
    expect(administrationDayLabel(1, "4:02pm")).toBe("1 today · last 4:02pm");
    expect(administrationDayLabel(2, "4:02pm")).toBe("2 today · last 4:02pm");
    // A count with no last-time (shouldn't normally happen) degrades gracefully.
    expect(administrationDayLabel(3, "")).toBe("3 today");
  });
});

describe("administrationLastDoseLabel", () => {
  it("leaves the daily count to an adjacent redose status", () => {
    expect(administrationLastDoseLabel(0, "")).toBe("None today");
    expect(administrationLastDoseLabel(1, "4:02pm")).toBe("Last dose 4:02pm");
    expect(administrationLastDoseLabel(2, "4:02pm")).toBe("Last dose 4:02pm");
    expect(administrationLastDoseLabel(3, "")).toBe("3 today");
  });
});

describe("administrationOutcomeText", () => {
  const cases: [AdministrationOutcome, string][] = [
    [
      { kind: "logged", count: 1, lastGivenAt: "x", date: "d" },
      "Logged ✅ Ibuprofen",
    ],
    [
      { kind: "logged", count: 3, lastGivenAt: "x", date: "d" },
      "Logged ✅ Ibuprofen — 3 today",
    ],
    [
      { kind: "duplicate", count: 1, lastGivenAt: "x", date: "d" },
      "Already logged",
    ],
    [{ kind: "invalid-time" }, "out of range"],
    [{ kind: "inactive" }, "paused"],
    [{ kind: "stale-item" }, "out of date"],
  ];
  it.each(cases)(
    "names the med and states the honest outcome",
    (outcome, needle) => {
      expect(administrationOutcomeText(outcome, "Ibuprofen")).toContain(needle);
    }
  );
  it("only 'logged'/'duplicate' count as a recorded intake", () => {
    expect(
      administrationLogged({
        kind: "logged",
        count: 1,
        lastGivenAt: "x",
        date: "d",
      })
    ).toBe(true);
    expect(
      administrationLogged({
        kind: "duplicate",
        count: 1,
        lastGivenAt: "x",
        date: "d",
      })
    ).toBe(true);
    expect(administrationLogged({ kind: "invalid-time" })).toBe(false);
    expect(administrationLogged({ kind: "inactive" })).toBe(false);
    expect(administrationLogged({ kind: "stale-item" })).toBe(false);
  });
});

describe("isGivenAtAccepted (#614 window guard for recorded_at)", () => {
  const tz = "UTC";
  const now = new Date("2026-07-15T12:00:00Z");
  const todayStr = "2026-07-15";

  it("accepts now and a same-day retro time", () => {
    expect(isGivenAtAccepted(tz, todayStr, now, now)).toBe(true);
    expect(
      isGivenAtAccepted(tz, todayStr, new Date("2026-07-15T04:00:00Z"), now)
    ).toBe(true);
  });
  it("accepts a time within the date window (yesterday)", () => {
    expect(
      isGivenAtAccepted(tz, todayStr, new Date("2026-07-14T23:00:00Z"), now)
    ).toBe(true);
  });
  it("refuses a genuinely future time (beyond the skew)", () => {
    expect(
      isGivenAtAccepted(tz, todayStr, new Date("2026-07-15T13:00:00Z"), now)
    ).toBe(false);
  });
  it("tolerates a small clock-skew future (a few minutes)", () => {
    expect(
      isGivenAtAccepted(tz, todayStr, new Date("2026-07-15T12:02:00Z"), now)
    ).toBe(true);
  });
  it("refuses a far-past time outside the window", () => {
    // 5 days ago > DOSE_LOG_DATE_WINDOW_DAYS.
    expect(DOSE_LOG_DATE_WINDOW_DAYS).toBeLessThan(5);
    expect(
      isGivenAtAccepted(tz, todayStr, new Date("2026-07-10T12:00:00Z"), now)
    ).toBe(false);
  });
  it("refuses an unparseable date", () => {
    expect(isGivenAtAccepted(tz, todayStr, new Date("garbage"), now)).toBe(
      false
    );
  });
});

describe("isHistoricalDoseTimeAccepted", () => {
  const tz = "UTC";
  const now = new Date("2026-07-15T12:00:00Z");
  const todayStr = "2026-07-15";

  it("accepts an intentional entry at any past date", () => {
    expect(
      isHistoricalDoseTimeAccepted(
        tz,
        todayStr,
        new Date("2021-06-25T08:00:00Z"),
        now
      )
    ).toBe(true);
  });

  it("rejects future and invalid instants", () => {
    expect(
      isHistoricalDoseTimeAccepted(
        tz,
        todayStr,
        new Date("2026-07-16T08:00:00Z"),
        now
      )
    ).toBe(false);
    expect(
      isHistoricalDoseTimeAccepted(tz, todayStr, new Date("invalid"), now)
    ).toBe(false);
  });
});

describe("isDoseDateAccepted (the ONE dose-log date window, #1427)", () => {
  it("accepts today and the edges of the window, refuses beyond it", () => {
    expect(isDoseDateAccepted("2026-07-15", "2026-07-15")).toBe(true);
    expect(isDoseDateAccepted("2026-07-15", "2026-07-13")).toBe(true);
    expect(isDoseDateAccepted("2026-07-15", "2026-07-17")).toBe(true);
    expect(isDoseDateAccepted("2026-07-15", "2026-07-12")).toBe(false);
    expect(isDoseDateAccepted("2026-07-15", "2026-07-18")).toBe(false);
    // Garbage never squeaks through as "0 days apart".
    expect(isDoseDateAccepted("2026-07-15", "not-a-date")).toBe(false);
  });

  it("agrees with the window constant it is derived from", () => {
    expect(DOSE_LOG_DATE_WINDOW_DAYS).toBe(2);
  });
});

describe("resolveQueuedTakenAt (offline confirm timestamp, #1427)", () => {
  const tz = "America/New_York";
  // 2026-07-15 12:00 UTC = 08:00 in New York.
  const now = new Date("2026-07-15T12:00:00Z");
  const date = "2026-07-15";

  it("keeps a captured tap time that falls on the log's own profile-local day", () => {
    // 06:30 New York, hours before the replay — the whole point of the field.
    const tapped = new Date("2026-07-15T10:30:00Z");
    expect(resolveQueuedTakenAt(tapped, tz, date, now)).toBe(tapped);
  });

  it("keeps a stamp that is UTC-yesterday but profile-local TODAY", () => {
    // 2026-07-15 02:00 UTC is still 2026-07-14 22:00 in New York, so for a log row
    // dated the 14th the stamp is on-day even though its UTC date differs.
    const tapped = new Date("2026-07-15T02:00:00Z");
    expect(resolveQueuedTakenAt(tapped, tz, "2026-07-14", now)).toBe(tapped);
    // ...and it is NOT accepted for a row dated the 15th.
    expect(resolveQueuedTakenAt(tapped, tz, "2026-07-15", now)).toBeNull();
  });

  it("falls back (null) rather than dropping the confirm on an unusable stamp", () => {
    // Missing entirely (an intent queued before the field shipped).
    expect(resolveQueuedTakenAt(undefined, tz, date, now)).toBeNull();
    expect(resolveQueuedTakenAt(null, tz, date, now)).toBeNull();
    // Unparseable.
    expect(resolveQueuedTakenAt(new Date("garbage"), tz, date, now)).toBeNull();
    // A clock running an hour fast — beyond the future skew.
    expect(
      resolveQueuedTakenAt(new Date("2026-07-15T13:00:00Z"), tz, date, now)
    ).toBeNull();
    // A stamp on a different profile-local day than the row it would sit on.
    expect(
      resolveQueuedTakenAt(new Date("2026-07-13T16:00:00Z"), tz, date, now)
    ).toBeNull();
  });

  it("tolerates a small clock skew inside the shared allowance", () => {
    const slightlyAhead = new Date(now.getTime() + 60_000);
    expect(resolveQueuedTakenAt(slightlyAhead, tz, date, now)).toBe(
      slightlyAhead
    );
  });
});
