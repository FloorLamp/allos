import { describe, it, expect } from "vitest";
import {
  buildAppointmentIcs,
  appointmentToIcsEvent,
  selectFeedAppointments,
  appointmentToPreviewRow,
  selectFeedPreviewRows,
  escapeIcsText,
  zonedWallTimeToUtc,
  type AppointmentLike,
  type IcsEvent,
} from "@/lib/calendar-ics";

const DTSTAMP = new Date("2026-07-08T12:00:00Z");

// Split a folded ICS string back into logical (unfolded) content lines: a CRLF
// followed by a single space/tab is a continuation of the previous line.
function unfold(ics: string): string[] {
  return ics
    .replace(/\r\n[ \t]/g, "")
    .split("\r\n")
    .filter(Boolean);
}

function timedEvent(over: Partial<IcsEvent> = {}): IcsEvent {
  return {
    uid: "appt-1@allos",
    status: "CONFIRMED",
    sequence: 0,
    summary: "Medical appointment",
    location: null,
    description: null,
    alarms: true,
    allDay: false,
    start: new Date("2026-07-10T18:30:00Z"),
    end: new Date("2026-07-10T19:30:00Z"),
    ...over,
  };
}

describe("buildAppointmentIcs — calendar structure", () => {
  it("emits the required VCALENDAR headers with CRLF endings", () => {
    const ics = buildAppointmentIcs([], { dtstamp: DTSTAMP });
    expect(ics.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(ics.endsWith("END:VCALENDAR\r\n")).toBe(true);
    const lines = unfold(ics);
    expect(lines).toContain("VERSION:2.0");
    expect(lines).toContain("PRODID:-//Allos//Appointments//EN");
    expect(lines).toContain("CALSCALE:GREGORIAN");
    // Every line break is a CRLF (no bare LF).
    expect(ics.includes("\n")).toBe(true);
    expect(/[^\r]\n/.test(ics)).toBe(false);
  });

  it("an empty list yields a valid, event-free calendar", () => {
    const ics = buildAppointmentIcs([], { dtstamp: DTSTAMP });
    expect(ics).not.toContain("BEGIN:VEVENT");
    expect(unfold(ics)).toEqual([
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//Allos//Appointments//EN",
      "CALSCALE:GREGORIAN",
      "METHOD:PUBLISH",
      "END:VCALENDAR",
    ]);
  });

  it("honors a custom prodId", () => {
    const ics = buildAppointmentIcs([], {
      dtstamp: DTSTAMP,
      prodId: "-//X//Y//EN",
    });
    expect(unfold(ics)).toContain("PRODID:-//X//Y//EN");
  });
});

describe("buildAppointmentIcs — a timed VEVENT", () => {
  it("serializes UID/DTSTAMP/DTSTART/DTEND as UTC Z and the reminders", () => {
    const ics = buildAppointmentIcs([timedEvent()], { dtstamp: DTSTAMP });
    const lines = unfold(ics);
    expect(lines).toContain("UID:appt-1@allos");
    expect(lines).toContain("DTSTAMP:20260708T120000Z");
    expect(lines).toContain("DTSTART:20260710T183000Z");
    expect(lines).toContain("DTEND:20260710T193000Z");
    expect(lines).toContain("STATUS:CONFIRMED");
    expect(lines).toContain("SEQUENCE:0");
    // Two DISPLAY alarms: 1 day + 1 hour before.
    expect(lines.filter((l) => l === "BEGIN:VALARM").length).toBe(2);
    expect(lines).toContain("TRIGGER:-P1D");
    expect(lines).toContain("TRIGGER:-PT1H");
    expect(lines).toContain("ACTION:DISPLAY");
  });

  it("a cancelled event is CANCELLED, SEQUENCE bumped, no alarms", () => {
    const ics = buildAppointmentIcs(
      [timedEvent({ status: "CANCELLED", sequence: 1, alarms: false })],
      { dtstamp: DTSTAMP }
    );
    const lines = unfold(ics);
    expect(lines).toContain("STATUS:CANCELLED");
    expect(lines).toContain("SEQUENCE:1");
    expect(lines).not.toContain("BEGIN:VALARM");
  });
});

describe("buildAppointmentIcs — all-day VEVENT", () => {
  it("uses VALUE=DATE with an exclusive next-day DTEND", () => {
    const ics = buildAppointmentIcs(
      [
        timedEvent({
          allDay: true,
          start: new Date("2026-07-10T00:00:00Z"),
          end: new Date("2026-07-11T00:00:00Z"),
        }),
      ],
      { dtstamp: DTSTAMP }
    );
    const lines = unfold(ics);
    expect(lines).toContain("DTSTART;VALUE=DATE:20260710");
    expect(lines).toContain("DTEND;VALUE=DATE:20260711");
    expect(ics).not.toContain("DTSTART:2026"); // not a timed value
  });
});

describe("escaping + folding (RFC 5545)", () => {
  it("escapes backslash, semicolon, comma and newlines; not colon", () => {
    expect(escapeIcsText("a,b;c\\d\ne: f")).toBe("a\\,b\\;c\\\\d\\ne: f");
  });

  it("escapes special characters inside SUMMARY/DESCRIPTION", () => {
    const ics = buildAppointmentIcs(
      [
        timedEvent({
          summary: "Dr. Lee, Cardiology; follow-up",
          description: "Line1\nLine2",
        }),
      ],
      { dtstamp: DTSTAMP }
    );
    const lines = unfold(ics);
    expect(lines).toContain("SUMMARY:Dr. Lee\\, Cardiology\\; follow-up");
    expect(lines).toContain("DESCRIPTION:Line1\\nLine2");
  });

  it("folds lines longer than 75 octets and they unfold to the original", () => {
    const longSummary = "X".repeat(200);
    const ics = buildAppointmentIcs([timedEvent({ summary: longSummary })], {
      dtstamp: DTSTAMP,
    });
    // No physical line exceeds 75 octets.
    for (const physical of ics.split("\r\n")) {
      expect(Buffer.byteLength(physical, "utf8")).toBeLessThanOrEqual(75);
    }
    // Unfolding reconstructs the full SUMMARY.
    expect(unfold(ics)).toContain(`SUMMARY:${longSummary}`);
  });

  it("never splits a multi-byte character across a fold boundary", () => {
    // Emoji are 4 UTF-8 bytes; a run of them must fold on code-point boundaries.
    const ics = buildAppointmentIcs(
      [timedEvent({ summary: "🏥".repeat(40) })],
      { dtstamp: DTSTAMP }
    );
    for (const physical of ics.split("\r\n")) {
      expect(Buffer.byteLength(physical, "utf8")).toBeLessThanOrEqual(75);
    }
    // Round-trips without mojibake.
    expect(unfold(ics)).toContain(`SUMMARY:${"🏥".repeat(40)}`);
  });
});

describe("zonedWallTimeToUtc", () => {
  it("interprets a wall time in an IANA zone as the right UTC instant (DST)", () => {
    // 2026-07-10 14:30 in New York is EDT (UTC-4) → 18:30 UTC.
    expect(zonedWallTimeToUtc(2026, 7, 10, 14, 30, "America/New_York")).toEqual(
      new Date("2026-07-10T18:30:00Z")
    );
    // 2026-01-10 14:30 in New York is EST (UTC-5) → 19:30 UTC.
    expect(zonedWallTimeToUtc(2026, 1, 10, 14, 30, "America/New_York")).toEqual(
      new Date("2026-01-10T19:30:00Z")
    );
  });

  it("UTC passes through unchanged", () => {
    expect(zonedWallTimeToUtc(2026, 7, 10, 9, 0, "UTC")).toEqual(
      new Date("2026-07-10T09:00:00Z")
    );
  });
});

describe("appointmentToIcsEvent — detail levels + timing", () => {
  const base: AppointmentLike = {
    id: 7,
    scheduled_at: "2026-07-10 14:30",
    status: "scheduled",
    title: "Cardiology follow-up",
    location: "Heart Center",
    provider_name: "Dr. Lee",
    notes: "Bring med list",
  };

  it("minimal: neutral summary, location kept, no provider/reason", () => {
    const ev = appointmentToIcsEvent(base, {
      tz: "America/New_York",
      detail: "minimal",
    });
    expect(ev.summary).toBe("Medical appointment");
    expect(ev.location).toBe("Heart Center");
    expect(ev.description).toBeNull();
    expect(ev.uid).toBe("appt-7@allos");
    expect(ev.allDay).toBe(false);
    expect(ev.start).toEqual(new Date("2026-07-10T18:30:00Z"));
    expect(ev.end).toEqual(new Date("2026-07-10T19:30:00Z"));
    expect(ev.status).toBe("CONFIRMED");
    expect(ev.alarms).toBe(true);
  });

  it("full: real title + provider/notes in SUMMARY/DESCRIPTION", () => {
    const ev = appointmentToIcsEvent(base, {
      tz: "America/New_York",
      detail: "full",
    });
    expect(ev.summary).toBe("Cardiology follow-up");
    expect(ev.description).toBe("Provider: Dr. Lee\nBring med list");
    expect(ev.location).toBe("Heart Center");
  });

  it("full: falls back to provider then generic when no title", () => {
    const ev = appointmentToIcsEvent(
      { ...base, title: null },
      { tz: "UTC", detail: "full" }
    );
    expect(ev.summary).toBe("Dr. Lee");
    const ev2 = appointmentToIcsEvent(
      { ...base, title: null, provider_name: null, notes: null },
      { tz: "UTC", detail: "full" }
    );
    expect(ev2.summary).toBe("Medical appointment");
    expect(ev2.description).toBeNull();
  });

  it("date-only scheduled_at becomes an all-day event", () => {
    const ev = appointmentToIcsEvent(
      { ...base, scheduled_at: "2026-07-10" },
      { tz: "America/New_York", detail: "minimal" }
    );
    expect(ev.allDay).toBe(true);
    expect(ev.start).toEqual(new Date("2026-07-10T00:00:00Z"));
    expect(ev.end).toEqual(new Date("2026-07-11T00:00:00Z"));
  });

  it("cancelled → CANCELLED, sequence 1, no alarms", () => {
    const ev = appointmentToIcsEvent(
      { ...base, status: "cancelled" },
      { tz: "UTC", detail: "minimal" }
    );
    expect(ev.status).toBe("CANCELLED");
    expect(ev.sequence).toBe(1);
    expect(ev.alarms).toBe(false);
  });
});

describe("selectFeedAppointments", () => {
  const today = "2026-07-08";
  const appts: AppointmentLike[] = [
    {
      id: 1,
      scheduled_at: "2026-07-20",
      status: "scheduled",
      title: null,
      location: null,
      provider_name: null,
      notes: null,
    },
    {
      id: 2,
      scheduled_at: "2026-07-01",
      status: "scheduled",
      title: null,
      location: null,
      provider_name: null,
      notes: null,
    },
    {
      id: 3,
      scheduled_at: "2026-01-01",
      status: "scheduled",
      title: null,
      location: null,
      provider_name: null,
      notes: null,
    }, // stale
    {
      id: 4,
      scheduled_at: "2026-06-20",
      status: "completed",
      title: null,
      location: null,
      provider_name: null,
      notes: null,
    },
    {
      id: 5,
      scheduled_at: "2026-07-05",
      status: "cancelled",
      title: null,
      location: null,
      provider_name: null,
      notes: null,
    },
  ];

  it("keeps scheduled + recently-cancelled, drops completed and stale", () => {
    const ids = selectFeedAppointments(appts, { today }).map((a) => a.id);
    expect(ids.sort()).toEqual([1, 2, 5]);
  });

  it("respects a custom past window", () => {
    const ids = selectFeedAppointments(appts, {
      today,
      pastWindowDays: 400,
    }).map((a) => a.id);
    // Now the January stale row is within window; completed still excluded.
    expect(ids.sort()).toEqual([1, 2, 3, 5]);
  });
});

describe("appointmentToPreviewRow — in-app preview projection", () => {
  const base: AppointmentLike = {
    id: 7,
    scheduled_at: "2026-07-10 14:30",
    status: "scheduled",
    title: "Cardiology follow-up",
    location: "Heart Center",
    provider_name: "Dr. Lee",
    notes: "Bring med list",
  };

  it("minimal: neutral summary (no provider/reason), timed labels, reminders", () => {
    const row = appointmentToPreviewRow(base, {
      tz: "America/New_York",
      detail: "minimal",
    });
    expect(row).toEqual({
      uid: "appt-7@allos",
      dateLabel: "Fri, Jul 10, 2026",
      timeLabel: "2:30 PM",
      summary: "Medical appointment",
      location: "Heart Center",
      cancelled: false,
      hasReminders: true,
    });
  });

  it("full: exposes the real title as the summary", () => {
    const row = appointmentToPreviewRow(base, {
      tz: "America/New_York",
      detail: "full",
    });
    expect(row.summary).toBe("Cardiology follow-up");
    expect(row.location).toBe("Heart Center");
  });

  it("all-day appointment has no time label", () => {
    const row = appointmentToPreviewRow(
      { ...base, scheduled_at: "2026-07-10" },
      { tz: "America/New_York", detail: "minimal" }
    );
    expect(row.timeLabel).toBeNull();
    expect(row.dateLabel).toBe("Fri, Jul 10, 2026");
  });

  it("midnight and noon render as 12:00 AM / 12:00 PM", () => {
    const midnight = appointmentToPreviewRow(
      { ...base, scheduled_at: "2026-07-10 00:00" },
      { tz: "UTC", detail: "minimal" }
    );
    expect(midnight.timeLabel).toBe("12:00 AM");
    const noon = appointmentToPreviewRow(
      { ...base, scheduled_at: "2026-07-10 12:00" },
      { tz: "UTC", detail: "minimal" }
    );
    expect(noon.timeLabel).toBe("12:00 PM");
  });

  it("cancelled appointment is flagged and carries no reminders", () => {
    const row = appointmentToPreviewRow(
      { ...base, status: "cancelled" },
      { tz: "UTC", detail: "minimal" }
    );
    expect(row.cancelled).toBe(true);
    expect(row.hasReminders).toBe(false);
  });
});

describe("selectFeedPreviewRows — selection + projection composed", () => {
  const today = "2026-07-08";

  it("empty input yields an empty list", () => {
    expect(
      selectFeedPreviewRows([], { today, tz: "UTC", detail: "minimal" })
    ).toEqual([]);
  });

  it("drops completed/stale rows and projects the rest to preview rows", () => {
    const appts: AppointmentLike[] = [
      {
        id: 1,
        scheduled_at: "2026-07-20 09:00",
        status: "scheduled",
        title: "Physical",
        location: null,
        provider_name: null,
        notes: null,
      },
      {
        id: 2,
        scheduled_at: "2026-06-20",
        status: "completed", // dropped
        title: null,
        location: null,
        provider_name: null,
        notes: null,
      },
      {
        id: 3,
        scheduled_at: "2026-01-01",
        status: "scheduled", // stale (outside 30-day past window)
        title: null,
        location: null,
        provider_name: null,
        notes: null,
      },
    ];
    const rows = selectFeedPreviewRows(appts, {
      today,
      tz: "UTC",
      detail: "minimal",
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].uid).toBe("appt-1@allos");
    expect(rows[0].timeLabel).toBe("9:00 AM");
    expect(rows[0].summary).toBe("Medical appointment");
  });
});
