import { describe, it, expect } from "vitest";
import {
  buildAppointmentIcs,
  appointmentToIcsEvent,
  selectFeedAppointments,
  appointmentToPreviewRow,
  selectFeedPreviewRows,
  consolidatedSummary,
  selectConsolidatedFeedEvents,
  selectConsolidatedPreviewRows,
  groupConsolidatedPreviewRows,
  escapeIcsText,
  zonedWallTimeToUtc,
  parseFeedCategories,
  canonicalizeFeedCategories,
  clampFeedWindowDays,
  upcomingSignalToIcsEvent,
  composeFeedEvents,
  composeFeedPreviewRows,
  FEED_CATEGORIES,
  DEFAULT_FEED_CATEGORIES,
  type AppointmentLike,
  type IcsEvent,
  type ConsolidatedProfileFeed,
  type FeedOptions,
  type UpcomingSignalLike,
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

// ---- Consolidated (multi-profile "family") feed ----------------------------

describe("consolidatedSummary — profile-name prefixing", () => {
  it("prefixes the summary with the profile name", () => {
    expect(consolidatedSummary("Ada", "Medical appointment")).toBe(
      "Ada: Medical appointment"
    );
  });
  it("is a no-op for a blank name", () => {
    expect(consolidatedSummary("", "Medical appointment")).toBe(
      "Medical appointment"
    );
    expect(consolidatedSummary("   ", "X")).toBe("X");
  });
});

// Two profiles' feeds, each with its own detail level + timezone. Ada is "full"
// (provider/reason leak), Leo is "minimal" (neutral label only).
function familyFixture(): ConsolidatedProfileFeed[] {
  return [
    {
      profileId: 7,
      profileName: "Ada",
      options: famOpts({ detail: "full" }),
      tz: "UTC",
      today: "2026-07-08",
      signals: [],
      appts: [
        {
          id: 1,
          scheduled_at: "2026-07-10 14:30",
          status: "scheduled",
          title: "Cardiology follow-up",
          location: "Heart Center",
          provider_name: "Dr. Lee",
          notes: null,
        },
      ],
    },
    {
      profileId: 9,
      profileName: "Leo",
      options: famOpts({ detail: "minimal" }),
      tz: "UTC",
      today: "2026-07-08",
      signals: [],
      appts: [
        {
          id: 1, // same appointment id as Ada's — must NOT collide
          scheduled_at: "2026-07-09 09:00",
          status: "scheduled",
          title: "Dermatology",
          location: null,
          provider_name: "Dr. Skin",
          notes: null,
        },
        {
          id: 2,
          scheduled_at: "2026-06-20",
          status: "completed", // history — dropped by the selector
          title: null,
          location: null,
          provider_name: null,
          notes: null,
        },
      ],
    },
  ];
}

// Full FeedOptions for a consolidated-feed profile (the family feed now honors each
// profile's whole customization, not just detail — issue #473). Appointments-only
// with reminders + the historical window unless overridden.
function famOpts(over: Partial<FeedOptions> = {}): FeedOptions {
  return {
    categories: ["appointment"],
    detail: "minimal",
    reminders: true,
    pastWindowDays: 30,
    futureWindowDays: null,
    ...over,
  };
}

describe("selectConsolidatedFeedEvents — multi-profile merge", () => {
  it("merges profiles, honors per-profile detail, and sorts chronologically", () => {
    const events = selectConsolidatedFeedEvents(familyFixture());
    // Leo's completed row is dropped; two scheduled events remain.
    expect(events).toHaveLength(2);
    // Sorted by start: Leo (Jul 9) before Ada (Jul 10).
    expect(events[0].summary).toBe("Leo: Medical appointment"); // minimal → neutral
    expect(events[1].summary).toBe("Ada: Cardiology follow-up"); // full → real title
  });

  it("namespaces UIDs by profile so a shared appointment id can't collide", () => {
    const events = selectConsolidatedFeedEvents(familyFixture());
    const uids = events.map((e) => e.uid);
    expect(uids).toContain("fam-9-appt-1@allos");
    expect(uids).toContain("fam-7-appt-1@allos");
    expect(new Set(uids).size).toBe(uids.length); // all distinct
  });

  it("minimal profiles leak no provider/reason into the merged feed", () => {
    const ics = buildAppointmentIcs(
      selectConsolidatedFeedEvents(familyFixture()),
      { dtstamp: DTSTAMP }
    );
    expect(ics).toContain("SUMMARY:Leo: Medical appointment");
    expect(ics).not.toContain("Dr. Skin");
    expect(ics).not.toContain("Dermatology");
    // Ada is full detail, so her provider/title DO appear.
    expect(ics).toContain("SUMMARY:Ada: Cardiology follow-up");
  });

  it("returns an empty list when no profiles are accessible", () => {
    expect(selectConsolidatedFeedEvents([])).toEqual([]);
  });
});

describe("selectConsolidatedPreviewRows + grouping", () => {
  it("labels each row with its profile and groups by date in order", () => {
    const rows = selectConsolidatedPreviewRows(familyFixture());
    expect(rows).toHaveLength(2);
    expect(rows[0].profileName).toBe("Leo");
    expect(rows[0].summary).toBe("Medical appointment"); // preview label is unprefixed
    expect(rows[1].profileName).toBe("Ada");

    const groups = groupConsolidatedPreviewRows(rows);
    expect(groups.map((g) => g.dateKey)).toEqual(["2026-07-09", "2026-07-10"]);
    expect(groups[0].rows[0].profileName).toBe("Leo");
    expect(groups[1].rows[0].profileName).toBe("Ada");
  });

  it("puts two same-day profiles in one date group", () => {
    const feeds = familyFixture();
    feeds[0].appts = [
      { ...feeds[0].appts[0], scheduled_at: "2026-07-09 16:00" },
    ];
    const groups = groupConsolidatedPreviewRows(
      selectConsolidatedPreviewRows(feeds)
    );
    expect(groups).toHaveLength(1);
    // Same day → grouped together; within the day the consolidated preview mirrors
    // composeFeedPreviewRows' date+uid ordering (fam-7 < fam-9), so Ada precedes Leo.
    expect(groups[0].rows.map((r) => r.profileName)).toEqual(["Ada", "Leo"]);
  });
});

describe("selectConsolidatedFeedEvents — honors per-profile customization (#473)", () => {
  it("includes a profile's enabled non-appointment categories in the family feed", () => {
    const feeds = familyFixture();
    // Ada turns on the dose category and contributes a due dose; Leo stays
    // appointments-only. The family feed must carry Ada's dose event.
    feeds[0].options = famOpts({
      detail: "minimal",
      categories: ["appointment", "dose"],
    });
    feeds[0].signals = [
      {
        key: "dose:99",
        domain: "dose",
        title: "Vitamin D",
        detail: "Medication",
        dueDate: "2026-07-08",
      },
    ];
    const events = selectConsolidatedFeedEvents(feeds);
    const summaries = events.map((e) => e.summary);
    // The dose rides in as a neutral (minimal) label, prefixed with the profile name.
    expect(summaries).toContain("Ada: Medication / supplement dose");
    // Leo's appointment-only feed still contributes just its appointment.
    expect(summaries).toContain("Leo: Medical appointment");
  });

  it("respects a profile's future window when merging", () => {
    const feeds = familyFixture();
    // Ada narrows her horizon to today only — her Jul-10 appointment (2 days out)
    // drops out of the family feed, honoring her per-profile window.
    feeds[0].options = famOpts({ detail: "full", futureWindowDays: 0 });
    const events = selectConsolidatedFeedEvents(feeds);
    const summaries = events.map((e) => e.summary);
    expect(summaries).not.toContain("Ada: Cardiology follow-up");
    expect(summaries).toContain("Leo: Medical appointment");
  });
});

// ---- Feed category customization (issue #12) -------------------------------

const TODAY = "2026-07-09";

function opts(over: Partial<FeedOptions> = {}): FeedOptions {
  return {
    categories: ["appointment"],
    detail: "minimal",
    reminders: true,
    pastWindowDays: 30,
    futureWindowDays: null,
    ...over,
  };
}

function signal(over: Partial<UpcomingSignalLike> = {}): UpcomingSignalLike {
  return {
    key: "dose:12",
    domain: "dose",
    title: "Vitamin D",
    detail: "Medication · 1000 IU",
    dueDate: null,
    ...over,
  };
}

describe("parseFeedCategories / canonicalizeFeedCategories", () => {
  it("defaults to appointments-only when unset/empty/unparseable", () => {
    expect(parseFeedCategories(null)).toEqual([...DEFAULT_FEED_CATEGORIES]);
    expect(parseFeedCategories(undefined)).toEqual(["appointment"]);
    expect(parseFeedCategories("")).toEqual(["appointment"]);
    expect(parseFeedCategories("not json")).toEqual(["appointment"]);
    expect(parseFeedCategories('{"x":1}')).toEqual(["appointment"]);
  });

  it("validates, de-dupes, and canonically orders", () => {
    expect(parseFeedCategories('["dose","appointment","dose"]')).toEqual([
      "appointment",
      "dose",
    ]);
    // Unknown values are dropped.
    expect(parseFeedCategories('["goal","bogus","refill"]')).toEqual([
      "refill",
      "goal",
    ]);
    // An explicit empty array is honored (feed serves nothing).
    expect(parseFeedCategories("[]")).toEqual([]);
    // Order always follows FEED_CATEGORIES regardless of input order.
    expect(
      canonicalizeFeedCategories(["training", "dose", "appointment"])
    ).toEqual(["appointment", "dose", "training"]);
  });
});

describe("clampFeedWindowDays", () => {
  it("clamps to a non-negative bounded integer", () => {
    expect(clampFeedWindowDays(30)).toBe(30);
    expect(clampFeedWindowDays(-5)).toBe(0);
    expect(clampFeedWindowDays(NaN)).toBe(0);
    expect(clampFeedWindowDays(99999)).toBe(3650);
    expect(clampFeedWindowDays(30.9)).toBe(30);
  });
});

describe("selectFeedAppointments — future horizon", () => {
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
      scheduled_at: "2026-09-01",
      status: "scheduled",
      title: null,
      location: null,
      provider_name: null,
      notes: null,
    },
  ];

  it("unbounded by default (no future filter)", () => {
    const out = selectFeedAppointments(appts, { today: TODAY });
    expect(out.map((a) => a.id)).toEqual([1, 2]);
  });

  it("drops appointments beyond the horizon", () => {
    const out = selectFeedAppointments(appts, {
      today: TODAY,
      futureWindowDays: 30, // through 2026-08-08
    });
    expect(out.map((a) => a.id)).toEqual([1]);
  });
});

describe("upcomingSignalToIcsEvent", () => {
  it("null due date anchors to today as an all-day event", () => {
    const ev = upcomingSignalToIcsEvent(signal(), {
      today: TODAY,
      detail: "minimal",
      reminders: true,
    });
    expect(ev.allDay).toBe(true);
    expect(ev.start).toEqual(new Date("2026-07-09T00:00:00Z"));
    expect(ev.end).toEqual(new Date("2026-07-10T00:00:00Z"));
    // UID is a stable HASH of the key (raw keys can embed names, which must
    // not ride into the feed at any detail level).
    expect(ev.uid).toMatch(/^up-[0-9a-f]{16}@allos$/);
    const again = upcomingSignalToIcsEvent(signal(), {
      today: TODAY,
      detail: "minimal",
      reminders: true,
    });
    expect(again.uid).toBe(ev.uid); // deterministic across fetches
  });

  it("the UID never leaks a key-embedded name, even at full detail (#12)", () => {
    const ev = upcomingSignalToIcsEvent(
      signal({ key: "biomarker:psa", domain: "biomarker" }),
      { today: TODAY, detail: "full", reminders: true }
    );
    expect(ev.uid).toMatch(/^up-[0-9a-f]{16}@allos$/);
    expect(ev.uid).not.toContain("psa");
    const other = upcomingSignalToIcsEvent(
      signal({ key: "biomarker:ldl", domain: "biomarker" }),
      { today: TODAY, detail: "full", reminders: true }
    );
    expect(other.uid).not.toBe(ev.uid); // distinct keys → distinct UIDs
  });

  it("minimal detail emits a neutral category label (no PHI name)", () => {
    const ev = upcomingSignalToIcsEvent(signal(), {
      today: TODAY,
      detail: "minimal",
      reminders: true,
    });
    expect(ev.summary).toBe("Medication / supplement dose");
    expect(ev.description).toBeNull();
  });

  it("full detail carries the real title + context", () => {
    const ev = upcomingSignalToIcsEvent(signal({ dueDate: "2026-07-15" }), {
      today: TODAY,
      detail: "full",
      reminders: false,
    });
    expect(ev.summary).toBe("Vitamin D");
    expect(ev.description).toBe("Medication · 1000 IU");
    expect(ev.alarms).toBe(false);
    expect(ev.start).toEqual(new Date("2026-07-15T00:00:00Z"));
  });
});

describe("composeFeedEvents", () => {
  const appt: AppointmentLike = {
    id: 5,
    scheduled_at: "2026-07-11 14:30",
    status: "scheduled",
    title: "Cardiology",
    location: "Heart Center",
    provider_name: "Dr Fake",
    notes: null,
  };
  const doseSig = signal({
    key: "dose:1",
    domain: "dose",
    dueDate: "2026-07-10",
  });
  const goalSig = signal({
    key: "goal:2",
    domain: "goal",
    title: "Run 5k",
    detail: null,
    dueDate: "2026-07-12",
  });

  it("appointments-only default excludes every signal", () => {
    const evs = composeFeedEvents({
      appointments: [appt],
      signals: [doseSig, goalSig],
      today: TODAY,
      tz: "UTC",
      options: opts(),
    });
    expect(evs).toHaveLength(1);
    expect(evs[0].uid).toBe("appt-5@allos");
  });

  it("includes only enabled non-appointment categories", () => {
    const evs = composeFeedEvents({
      appointments: [appt],
      signals: [doseSig, goalSig],
      today: TODAY,
      tz: "UTC",
      options: opts({ categories: ["appointment", "dose"] }),
    });
    const uids = evs.map((e) => e.uid);
    expect(uids).toContain("appt-5@allos");
    // dose kept, goal filtered: exactly one hashed signal UID alongside the appt.
    expect(uids).toHaveLength(2);
    expect(uids.filter((u) => /^up-[0-9a-f]{16}@allos$/.test(u))).toHaveLength(
      1
    );
  });

  it("never double-counts an appointment-domain signal", () => {
    const apptSignal = signal({
      key: "appointment:5",
      domain: "appointment",
      dueDate: "2026-07-11",
    });
    const evs = composeFeedEvents({
      appointments: [appt],
      signals: [apptSignal],
      today: TODAY,
      tz: "UTC",
      options: opts({ categories: ["appointment"] }),
    });
    // Only the rich appointment mapping produces an event, not the signal.
    expect(evs.map((e) => e.uid)).toEqual(["appt-5@allos"]);
  });

  it("honors the reminder toggle across categories", () => {
    const evs = composeFeedEvents({
      appointments: [appt],
      signals: [doseSig],
      today: TODAY,
      tz: "UTC",
      options: opts({ categories: ["appointment", "dose"], reminders: false }),
    });
    expect(evs.every((e) => e.alarms === false)).toBe(true);
  });

  it("applies the window to signals (future horizon)", () => {
    const evs = composeFeedEvents({
      appointments: [],
      signals: [doseSig, goalSig],
      today: TODAY,
      tz: "UTC",
      options: opts({
        categories: ["dose", "goal"],
        futureWindowDays: 1, // through 2026-07-10
      }),
    });
    // doseSig (07-10) in range; goalSig (07-12) out.
    expect(evs.map((e) => e.uid)).toHaveLength(1);
    expect(evs[0].uid).toMatch(/^up-[0-9a-f]{16}@allos$/);
  });

  it("is chronologically sorted", () => {
    const evs = composeFeedEvents({
      appointments: [appt],
      signals: [doseSig, goalSig],
      today: TODAY,
      tz: "UTC",
      options: opts({ categories: ["appointment", "dose", "goal"] }),
    });
    const dates = evs.map((e) => e.start.getTime());
    expect(dates).toEqual([...dates].sort((a, b) => a - b));
  });
});

describe("composeFeedPreviewRows mirrors composeFeedEvents", () => {
  const appt: AppointmentLike = {
    id: 5,
    scheduled_at: "2026-07-11 14:30",
    status: "scheduled",
    title: "Cardiology",
    location: "Heart Center",
    provider_name: null,
    notes: null,
  };
  const doseSig = signal({
    key: "dose:1",
    domain: "dose",
    dueDate: "2026-07-10",
  });

  it("emits one row per composed event, same uids + categories", () => {
    const input = {
      appointments: [appt],
      signals: [doseSig],
      today: TODAY,
      tz: "UTC",
      options: opts({ categories: ["appointment", "dose"] }),
    };
    const events = composeFeedEvents(input);
    const rows = composeFeedPreviewRows(input);
    expect(rows.map((r) => r.uid).sort()).toEqual(
      events.map((e) => e.uid).sort()
    );
    const apptRow = rows.find((r) => r.category === "appointment")!;
    expect(apptRow.timeLabel).toBe("2:30 PM");
    const doseRow = rows.find((r) => r.category === "dose")!;
    expect(doseRow.summary).toBe("Medication / supplement dose");
    expect(doseRow.timeLabel).toBeNull();
  });

  it("strips reminder flag when reminders are off", () => {
    const rows = composeFeedPreviewRows({
      appointments: [appt],
      signals: [],
      today: TODAY,
      tz: "UTC",
      options: opts({ reminders: false }),
    });
    expect(rows.every((r) => r.hasReminders === false)).toBe(true);
  });
});

describe("FEED_CATEGORIES completeness", () => {
  it("every category has a minimal-detail representation", () => {
    for (const cat of FEED_CATEGORIES) {
      const ev = upcomingSignalToIcsEvent(
        signal({ key: `${cat}:1`, domain: cat }),
        { today: TODAY, detail: "minimal", reminders: true }
      );
      expect(ev.summary.length).toBeGreaterThan(0);
    }
  });
});
