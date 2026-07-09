// Pure iCalendar (RFC 5545) generation for the appointment "subscribe" feed
// (calendar-feed integration). No DB, no network, no Date.now — the caller passes
// `now`/`dtstamp` and the profile timezone in, so this whole module is
// deterministic and exhaustively unit-tested (lib/__tests__/calendar-ics.test.ts).
//
// TIMEZONE APPROACH. Rather than emit a VTIMEZONE with hand-rolled DST rules (easy
// to get subtly wrong), timed events are anchored to a concrete UTC instant and
// serialized as UTC "Z" values (YYYYMMDDTHHMMSSZ). The wall-clock time a user
// entered ("2026-07-10 14:30") is interpreted in the profile's IANA timezone and
// converted to that instant here (zonedWallTimeToUtc, using Intl — the same engine
// lib/date uses). Every calendar client renders a UTC instant in the viewer's own
// local zone, so the appointment shows at the right wall-clock time without us
// shipping timezone tables. Date-only appointments become all-day VALUE=DATE
// events (no time, no zone — they're the same calendar day everywhere).

import { shiftDateStr } from "./date";

export type IcsDetail = "minimal" | "full";

// The subset of an appointment row this module needs. Kept structural (not the
// full Appointment type) so tests can construct minimal fixtures.
export interface AppointmentLike {
  id: number;
  scheduled_at: string; // "YYYY-MM-DD" (all-day) or "YYYY-MM-DD HH:MM" (timed)
  status: "scheduled" | "completed" | "cancelled";
  title: string | null;
  location: string | null;
  provider_name: string | null;
  notes: string | null;
}

// A fully-resolved calendar event, ready to serialize. Timing is either a UTC
// instant pair (timed) or a date pair (all-day, `end` exclusive).
export interface IcsEvent {
  uid: string;
  status: "CONFIRMED" | "CANCELLED";
  sequence: number;
  summary: string;
  location?: string | null;
  description?: string | null;
  alarms: boolean; // emit the -P1D / -PT1H reminders
  allDay: boolean;
  start: Date; // timed: the UTC instant; all-day: UTC-midnight date anchor
  end: Date; // timed: UTC instant; all-day: exclusive UTC-midnight end date
}

// ---- Timezone conversion (pure, Intl-based) --------------------------------

// The offset (ms) to ADD to a UTC instant to get the given zone's wall clock, at
// that instant. i.e. localWallAsIfUtc - utc. Derived by formatting the instant in
// the zone and reading it back as if it were UTC.
function zoneOffsetMs(utc: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(utc);
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  let hour = get("hour");
  if (hour === 24) hour = 0; // some ICU builds emit 24 for midnight
  const asUtc = Date.UTC(
    get("year"),
    get("month") - 1,
    get("day"),
    hour,
    get("minute"),
    get("second")
  );
  return asUtc - utc.getTime();
}

// Convert a wall-clock time (its calendar parts) in an IANA zone to the UTC
// instant it denotes. Two-pass so a time near a DST transition resolves with the
// offset that actually applies at the resulting instant (not the guess instant).
export function zonedWallTimeToUtc(
  y: number,
  mo: number, // 1-12
  d: number,
  h: number,
  mi: number,
  tz: string
): Date {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const off1 = zoneOffsetMs(new Date(guess), tz);
  let ms = guess - off1;
  const off2 = zoneOffsetMs(new Date(ms), tz);
  if (off2 !== off1) ms = guess - off2;
  return new Date(ms);
}

// ---- Appointment → event mapping (pure) ------------------------------------

const DATETIME_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/;

function trimOrNull(s: string | null | undefined): string | null {
  const v = s?.trim();
  return v ? v : null;
}

// Map one appointment to a resolved ICS event at the given detail level. The UID
// is stable (`appt-<id>@allos`) so re-fetching the feed UPDATES the same event
// rather than duplicating it. A cancelled appointment becomes STATUS:CANCELLED
// with a bumped SEQUENCE so subscribers see the cancellation propagate; scheduled
// ones are CONFIRMED and carry the reminder alarms.
export function appointmentToIcsEvent(
  a: AppointmentLike,
  opts: { tz: string; detail: IcsDetail; defaultDurationMin?: number }
): IcsEvent {
  const cancelled = a.status === "cancelled";
  const m = DATETIME_RE.exec(a.scheduled_at.trim());

  let allDay = true;
  let start: Date;
  let end: Date;
  if (m && m[4] != null && m[5] != null) {
    // Timed: interpret the wall clock in the profile timezone.
    allDay = false;
    const [y, mo, d, h, mi] = [+m[1], +m[2], +m[3], +m[4], +m[5]];
    start = zonedWallTimeToUtc(y, mo, d, h, mi, opts.tz);
    end = new Date(start.getTime() + (opts.defaultDurationMin ?? 60) * 60_000);
  } else {
    // All-day: anchor to UTC midnight; DTEND is the exclusive next day.
    const dateStr = (m ? `${m[1]}-${m[2]}-${m[3]}` : a.scheduled_at).slice(
      0,
      10
    );
    start = new Date(dateStr + "T00:00:00Z");
    end = new Date(shiftDateStr(dateStr, 1) + "T00:00:00Z");
  }

  const location = trimOrNull(a.location);
  const provider = trimOrNull(a.provider_name);
  const title = trimOrNull(a.title);

  let summary: string;
  let description: string | null = null;
  if (opts.detail === "full") {
    // Full detail: the real reason/title + provider + notes go to the calendar.
    summary = title ?? provider ?? "Medical appointment";
    const lines = [
      provider ? `Provider: ${provider}` : null,
      trimOrNull(a.notes),
    ].filter((x): x is string => x != null);
    description = lines.length ? lines.join("\n") : null;
  } else {
    // Minimal (default): no provider/reason leaves the app — just a neutral label
    // (+ location, which the user needs to actually get there).
    summary = "Medical appointment";
  }

  return {
    uid: `appt-${a.id}@allos`,
    status: cancelled ? "CANCELLED" : "CONFIRMED",
    sequence: cancelled ? 1 : 0,
    summary,
    location,
    description,
    alarms: !cancelled,
    allDay,
    start,
    end,
  };
}

// Which appointments belong in the feed: still-scheduled ones (including overdue,
// so a native reminder still helps) plus recently-cancelled ones (so the calendar
// removes/cancels an event the user already subscribed to). Completed visits are
// history and are dropped — they need no reminder and keep PHI out of the feed.
// `pastWindowDays` bounds how far back a stale row is carried.
export function selectFeedAppointments(
  appts: readonly AppointmentLike[],
  opts: { today: string; pastWindowDays?: number }
): AppointmentLike[] {
  const cutoff = shiftDateStr(opts.today, -(opts.pastWindowDays ?? 30));
  return appts.filter((a) => {
    if (a.status === "completed") return false;
    const day = a.scheduled_at.slice(0, 10);
    return day >= cutoff;
  });
}

// ---- UI preview projection (pure) ------------------------------------------

// A compact, display-ready projection of one feed event for the in-app "Preview"
// card on the calendar-feed integration page. It carries only what the UI shows —
// human date/time labels, the (detail-resolved) summary, location, and flags —
// NOT the UTC instants the ICS serializer needs. Deriving it from the SAME
// `appointmentToIcsEvent` mapping keeps the preview faithful to the real feed:
// the summary already reflects the minimal-vs-full detail level, and the
// cancelled/reminder flags mirror what a subscribed calendar would receive.
export interface CalendarFeedPreviewRow {
  uid: string;
  dateLabel: string; // e.g. "Fri, Jul 10, 2026"
  timeLabel: string | null; // e.g. "2:30 PM"; null for an all-day event
  summary: string;
  location: string | null;
  cancelled: boolean;
  hasReminders: boolean; // scheduled events carry the 1-day + 1-hour alarms
}

// Fixed English labels (not locale-formatted) so the projection is deterministic
// and unit-testable regardless of the runtime locale — matching how the rest of
// this module avoids environment-dependent formatting.
const PREVIEW_WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const PREVIEW_MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

// "Fri, Jul 10, 2026" from a YYYY-MM-DD calendar date. UTC-anchored, so the
// weekday is stable regardless of the process timezone (the date is a bare
// calendar day, the same everywhere).
function formatPreviewDate(dateStr: string): string {
  const y = +dateStr.slice(0, 4);
  const mo = +dateStr.slice(5, 7);
  const d = +dateStr.slice(8, 10);
  const dow = new Date(dateStr + "T00:00:00Z").getUTCDay();
  return `${PREVIEW_WEEKDAYS[dow]}, ${PREVIEW_MONTHS[mo - 1]} ${d}, ${y}`;
}

// "2:30 PM" from 24-hour wall-clock parts (the value the user entered, in the
// profile timezone — no conversion needed for display).
function formatPreviewTime(h: number, mi: number): string {
  const period = h < 12 ? "AM" : "PM";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(mi).padStart(2, "0")} ${period}`;
}

// Project one appointment to its preview row. Composes `appointmentToIcsEvent`
// (so summary/location/cancelled/reminder exactly match the feed at this detail
// level) and reads the date/time labels from the original wall-clock string.
export function appointmentToPreviewRow(
  a: AppointmentLike,
  opts: { tz: string; detail: IcsDetail; defaultDurationMin?: number }
): CalendarFeedPreviewRow {
  const ev = appointmentToIcsEvent(a, opts);
  const m = DATETIME_RE.exec(a.scheduled_at.trim());
  const dateStr = m ? `${m[1]}-${m[2]}-${m[3]}` : a.scheduled_at.slice(0, 10);
  const timed = !ev.allDay && m != null && m[4] != null && m[5] != null;
  return {
    uid: ev.uid,
    dateLabel: formatPreviewDate(dateStr),
    timeLabel: timed ? formatPreviewTime(+m![4], +m![5]) : null,
    summary: ev.summary,
    location: ev.location ?? null,
    cancelled: ev.status === "CANCELLED",
    hasReminders: ev.alarms,
  };
}

// Convenience: select the feed's appointments and project each to a preview row,
// composing the two existing pure functions so the preview can NEVER diverge from
// what the live route builds. The caller passes the SAME inputs the route uses
// (profile `today`/`tz`/`detail`/window), keeping the in-app preview faithful.
export function selectFeedPreviewRows(
  appts: readonly AppointmentLike[],
  opts: {
    today: string;
    tz: string;
    detail: IcsDetail;
    pastWindowDays?: number;
    defaultDurationMin?: number;
  }
): CalendarFeedPreviewRow[] {
  return selectFeedAppointments(appts, {
    today: opts.today,
    pastWindowDays: opts.pastWindowDays,
  }).map((a) =>
    appointmentToPreviewRow(a, {
      tz: opts.tz,
      detail: opts.detail,
      defaultDurationMin: opts.defaultDurationMin,
    })
  );
}

// ---- RFC 5545 serialization ------------------------------------------------

// Escape a TEXT value per RFC 5545 §3.3.11: backslash, semicolon, comma, and
// newlines are escaped (colon is NOT escaped in TEXT).
export function escapeIcsText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r\n|\r|\n/g, "\\n");
}

const encoder = new TextEncoder();

// Fold a single content line to <=75 OCTETS per line (RFC 5545 §3.1): a CRLF plus
// a single leading space begins each continuation. Counts UTF-8 bytes and folds on
// code-point boundaries so a multi-byte character is never split.
function foldLine(line: string): string {
  let out = "";
  let seg = "";
  let segBytes = 0;
  let limit = 75; // first line 75; continuations 74 (+1 for the leading space)
  for (const ch of line) {
    const b = encoder.encode(ch).length;
    if (segBytes + b > limit) {
      out += (out ? "\r\n " : "") + seg;
      seg = ch;
      segBytes = b;
      limit = 74;
    } else {
      seg += ch;
      segBytes += b;
    }
  }
  return out + (out ? "\r\n " : "") + seg;
}

// UTC "Z" timestamp: YYYYMMDDTHHMMSSZ.
function fmtUtc(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return (
    `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}` +
    `T${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`
  );
}

// Bare DATE: YYYYMMDD (from the UTC-midnight anchor).
function fmtDate(d: Date): string {
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getUTCFullYear(), 4)}${p(d.getUTCMonth() + 1)}${p(
    d.getUTCDate()
  )}`;
}

const DEFAULT_PRODID = "-//Allos//Appointments//EN";

// Build a complete VCALENDAR string from resolved events. `dtstamp` (a UTC instant
// the caller supplies — keeping this pure) stamps every VEVENT. An empty event
// list yields a valid, empty calendar. CRLF line endings throughout.
export function buildAppointmentIcs(
  events: readonly IcsEvent[],
  opts: { dtstamp: Date; prodId?: string }
): string {
  const lines: string[] = [];
  const push = (l: string) => lines.push(l);

  push("BEGIN:VCALENDAR");
  push("VERSION:2.0");
  push(`PRODID:${opts.prodId ?? DEFAULT_PRODID}`);
  push("CALSCALE:GREGORIAN");
  push("METHOD:PUBLISH");

  const stamp = fmtUtc(opts.dtstamp);

  for (const ev of events) {
    push("BEGIN:VEVENT");
    push(`UID:${ev.uid}`);
    push(`DTSTAMP:${stamp}`);
    if (ev.allDay) {
      push(`DTSTART;VALUE=DATE:${fmtDate(ev.start)}`);
      push(`DTEND;VALUE=DATE:${fmtDate(ev.end)}`);
    } else {
      push(`DTSTART:${fmtUtc(ev.start)}`);
      push(`DTEND:${fmtUtc(ev.end)}`);
    }
    push(`SUMMARY:${escapeIcsText(ev.summary)}`);
    if (ev.location) push(`LOCATION:${escapeIcsText(ev.location)}`);
    if (ev.description) push(`DESCRIPTION:${escapeIcsText(ev.description)}`);
    push(`STATUS:${ev.status}`);
    push(`SEQUENCE:${ev.sequence}`);
    push("TRANSP:OPAQUE");
    if (ev.alarms) {
      for (const trigger of ["-P1D", "-PT1H"]) {
        push("BEGIN:VALARM");
        push("ACTION:DISPLAY");
        push("DESCRIPTION:Reminder");
        push(`TRIGGER:${trigger}`);
        push("END:VALARM");
      }
    }
    push("END:VEVENT");
  }

  push("END:VCALENDAR");

  // Fold each content line, then join with CRLF and end with a trailing CRLF.
  return lines.map(foldLine).join("\r\n") + "\r\n";
}
