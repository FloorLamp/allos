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
// `pastWindowDays` bounds how far back a stale row is carried; `futureWindowDays`
// (issue #12) optionally bounds how far AHEAD — null/undefined keeps the historical
// unbounded-future behaviour (a visit years out still rides the feed).
export function selectFeedAppointments(
  appts: readonly AppointmentLike[],
  opts: {
    today: string;
    pastWindowDays?: number;
    futureWindowDays?: number | null;
  }
): AppointmentLike[] {
  const cutoff = shiftDateStr(opts.today, -(opts.pastWindowDays ?? 30));
  const horizon =
    opts.futureWindowDays != null && opts.futureWindowDays >= 0
      ? shiftDateStr(opts.today, opts.futureWindowDays)
      : null;
  return appts.filter((a) => {
    if (a.status === "completed") return false;
    const day = a.scheduled_at.slice(0, 10);
    if (day < cutoff) return false;
    if (horizon != null && day > horizon) return false;
    return true;
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

// The public calendar preview has no login preference context, so it keeps its fixed
// documented 12-hour clock while authenticated surfaces use the login formatter.
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

// ---- Feed category customization (issue #12) -------------------------------
// The feed historically carried ONLY medical appointments. It can now optionally
// include the other forward-looking due-signals the Upcoming aggregator already
// computes (doses, refills, immunizations, biomarker retests, goal deadlines,
// training targets). Each category is an opt-in; the default stays appointments-
// only, so an existing feed is unchanged until the user turns something on. All of
// this is pure — the route resolves the enabled set + the collected signals and
// passes them in, so the composition/filtering decisions live here and are tested.

// A feed category maps 1:1 onto an UpcomingDomain (same names). "appointment"
// is special: it flows through the rich appointment mapping (timed events,
// cancellations, provider/reason at full detail), not the generic signal mapping.
export type FeedCategory =
  | "appointment"
  | "dose"
  | "refill"
  | "careplan"
  | "visit"
  | "screening"
  | "immunization"
  | "biomarker"
  | "goal"
  | "training";

// Canonical order (also the serialized/preview sort tiebreak within a day).
export const FEED_CATEGORIES: readonly FeedCategory[] = [
  "appointment",
  "dose",
  "refill",
  "careplan",
  "visit",
  "screening",
  "immunization",
  "biomarker",
  "goal",
  "training",
];

// The default enabled set: appointments only — preserves the historical feed so a
// pre-existing subscription sees no change until the user opts into more.
export const DEFAULT_FEED_CATEGORIES: readonly FeedCategory[] = ["appointment"];

// "Concrete" categories are hard, dated commitments (a booked visit, a scheduled
// dose, a running-low refill). "Suggested" ones are softer, status-driven nudges
// (a vaccine that's due, a lab worth redrawing, a goal/training pace). The UI
// groups them so the noisier suggestions are a separate opt-in (per the issue's
// "gate concrete vs suggested" note) — a calendar of recommendations gets busy.
export const CONCRETE_FEED_CATEGORIES: readonly FeedCategory[] = [
  "appointment",
  "dose",
  "refill",
  "careplan",
];
export const SUGGESTED_FEED_CATEGORIES: readonly FeedCategory[] = [
  "visit",
  "screening",
  "immunization",
  "biomarker",
  "goal",
  "training",
];

// PHI-conscious neutral label per non-appointment category, emitted at MINIMAL
// detail so a subscribed calendar reveals only the KIND of item — never the
// medication/lab/goal name (which is PHI). Full detail swaps in the real title.
const CATEGORY_MINIMAL_LABEL: Record<
  Exclude<FeedCategory, "appointment">,
  string
> = {
  dose: "Medication / supplement dose",
  refill: "Refill running low",
  careplan: "Planned care due",
  visit: "Preventive visit due",
  screening: "Preventive screening due",
  immunization: "Immunization due",
  biomarker: "Lab retest due",
  goal: "Goal deadline",
  training: "Training target",
};

// Human labels for the settings UI (kept beside the categories so the list can't
// drift from the enum).
export const FEED_CATEGORY_LABELS: Record<FeedCategory, string> = {
  appointment: "Medical appointments",
  dose: "Doses due",
  refill: "Refills running low",
  careplan: "Planned care",
  visit: "Preventive visits due",
  screening: "Preventive screenings due",
  immunization: "Immunizations due",
  biomarker: "Biomarker retests",
  goal: "Goal deadlines",
  training: "Training targets",
};

export function isFeedCategory(s: string): s is FeedCategory {
  return (FEED_CATEGORIES as readonly string[]).includes(s);
}

// Narrow a collected Upcoming list to the signals a calendar feed can carry: those
// whose domain is a FeedCategory. Standing advisories with no calendar meaning
// (e.g. the dietary-limit UL warnings, issue #148 — no due date) are dropped here
// so they never reach the feed, and the result is assignable to
// UpcomingSignalLike[] (its domain narrowed to FeedCategory).
export function feedEligibleSignals<T extends { domain: string }>(
  items: readonly T[]
): (T & { domain: FeedCategory })[] {
  return items.filter((i): i is T & { domain: FeedCategory } =>
    isFeedCategory(i.domain)
  );
}

// Validate + de-dupe + canonically order an arbitrary list of category strings.
// Unknown values are dropped. Used by the action (form input) and the parser.
export function canonicalizeFeedCategories(
  list: readonly string[]
): FeedCategory[] {
  const set = new Set(list.filter(isFeedCategory));
  return FEED_CATEGORIES.filter((c) => set.has(c));
}

// Parse the stored `calendar_feed_categories` value (a JSON string array) into a
// validated, canonically-ordered list. An ABSENT setting (null/undefined/empty)
// falls back to the appointments-only default so the historical feed is preserved;
// anything unparseable also falls back rather than silently emptying the feed. An
// explicitly-stored empty array is honored as "no categories" (feed serves nothing).
export function parseFeedCategories(
  raw: string | null | undefined
): FeedCategory[] {
  if (raw == null || raw === "") return [...DEFAULT_FEED_CATEGORIES];
  let arr: unknown;
  try {
    arr = JSON.parse(raw);
  } catch {
    return [...DEFAULT_FEED_CATEGORIES];
  }
  if (!Array.isArray(arr)) return [...DEFAULT_FEED_CATEGORIES];
  return canonicalizeFeedCategories(
    arr.filter((x): x is string => typeof x === "string")
  );
}

// Clamp a past/future window (days) to a sane, non-negative range. Guards the
// stored setting AND the form input against nonsense (NaN, negatives, absurd spans).
export const MAX_FEED_WINDOW_DAYS = 3650; // ~10y
export function clampFeedWindowDays(n: number): number {
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(Math.floor(n), MAX_FEED_WINDOW_DAYS);
}

// The full resolved customization the feed composition honors. `futureWindowDays`
// null = unbounded (historical behaviour). Detail is the existing minimal/full
// PHI toggle, now applied to every category's summary/description.
export interface FeedOptions {
  categories: readonly FeedCategory[];
  detail: IcsDetail;
  reminders: boolean; // emit VALARM reminders on events
  pastWindowDays: number;
  futureWindowDays: number | null;
}

// The subset of an UpcomingItem this module needs to turn a non-appointment
// due-signal into a calendar event. Structurally compatible with UpcomingItem
// (lib/upcoming.ts), so the route passes those straight through — kept structural
// so this module stays free of a query-layer import and is testable with fixtures.
export interface UpcomingSignalLike {
  key: string; // stable, namespaced id ("dose:12", "biomarker:ldl")
  domain: FeedCategory;
  title: string;
  detail?: string | null;
  dueDate: string | null; // "YYYY-MM-DD", or null for a "due today" signal
}

// Stable 64-bit FNV-1a hash of a string, as 16 hex chars. Used to derive signal
// UIDs from their keys WITHOUT embedding the key text: some keys carry a name
// ("biomarker:psa"), and a UID rides in the serialized feed at every detail
// level, so the raw key would leak the analyte even when the summary is the
// neutral minimal label. Deterministic (same key → same UID across fetches, so a
// re-fetch still UPDATES the same event) and dependency-free to keep this module
// pure.
function fnv1a64Hex(s: string): string {
  // Two independent 32-bit FNV-1a passes (offset basis varied) → 64 bits.
  let h1 = 0x811c9dc5;
  let h2 = 0xcbf29ce4;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ c, 0x01000193) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

// Map one non-appointment due-signal to an all-day ICS event. A null due date
// (a "due today" signal like a scheduled dose or training pace) anchors to today.
// At minimal detail the summary is the neutral category label (no name leaves the
// app); at full detail the real title rides along plus its context line. The UID
// is a HASH of the signal key — stable across fetches (a re-fetch UPDATES the
// same event), never colliding with an appointment UID, and never leaking a
// key-embedded name into the serialized feed.
export function upcomingSignalToIcsEvent(
  item: UpcomingSignalLike,
  opts: { today: string; detail: IcsDetail; reminders: boolean }
): IcsEvent {
  const dateStr = (item.dueDate ?? opts.today).slice(0, 10);
  const start = new Date(dateStr + "T00:00:00Z");
  const end = new Date(shiftDateStr(dateStr, 1) + "T00:00:00Z");
  const minimalLabel =
    item.domain === "appointment"
      ? "Medical appointment"
      : CATEGORY_MINIMAL_LABEL[item.domain];
  const title = trimOrNull(item.title);
  const summary =
    opts.detail === "full" ? (title ?? minimalLabel) : minimalLabel;
  const description = opts.detail === "full" ? trimOrNull(item.detail) : null;
  return {
    uid: `up-${fnv1a64Hex(item.key)}@allos`,
    status: "CONFIRMED",
    sequence: 0,
    summary,
    location: null,
    description,
    alarms: opts.reminders,
    allDay: true,
    start,
    end,
  };
}

// Whether an event date falls inside the configured window. Past cutoff is always
// applied; the future horizon only when set (null = unbounded).
function withinWindow(
  day: string,
  today: string,
  pastWindowDays: number,
  futureWindowDays: number | null
): boolean {
  if (day < shiftDateStr(today, -pastWindowDays)) return false;
  if (
    futureWindowDays != null &&
    futureWindowDays >= 0 &&
    day > shiftDateStr(today, futureWindowDays)
  )
    return false;
  return true;
}

// Compose the complete resolved event list for a feed from its two sources — the
// rich appointment rows and the generic upcoming signals — honoring the enabled
// categories, detail level, reminder toggle, and window. Appointments always flow
// through the appointment mapping (so timed/cancelled/provider handling is intact);
// every other enabled category comes from `signals` (appointment-domain signals are
// ignored here — they'd double-count the rich path). Deterministically sorted so the
// serialized feed is stable. Pure: the caller supplies the reads + `today`/`tz`.
export function composeFeedEvents(input: {
  appointments: readonly AppointmentLike[];
  signals: readonly UpcomingSignalLike[];
  today: string;
  tz: string;
  options: FeedOptions;
}): IcsEvent[] {
  const { appointments, signals, today, tz, options } = input;
  const enabled = new Set(options.categories);
  const events: IcsEvent[] = [];

  if (enabled.has("appointment")) {
    const selected = selectFeedAppointments(appointments, {
      today,
      pastWindowDays: options.pastWindowDays,
      futureWindowDays: options.futureWindowDays,
    });
    for (const a of selected) {
      const ev = appointmentToIcsEvent(a, { tz, detail: options.detail });
      // Honor the global reminder toggle (a cancelled event never has alarms).
      events.push(options.reminders ? ev : { ...ev, alarms: false });
    }
  }

  for (const s of signals) {
    if (s.domain === "appointment") continue; // rich path owns appointments
    if (!enabled.has(s.domain)) continue;
    const day = (s.dueDate ?? today).slice(0, 10);
    if (
      !withinWindow(
        day,
        today,
        options.pastWindowDays,
        options.futureWindowDays
      )
    )
      continue;
    events.push(
      upcomingSignalToIcsEvent(s, {
        today,
        detail: options.detail,
        reminders: options.reminders,
      })
    );
  }

  events.sort(
    (x, y) =>
      x.start.getTime() - y.start.getTime() || x.uid.localeCompare(y.uid)
  );
  return events;
}

// ---- Unified feed preview (pure) -------------------------------------------
// The in-app "Preview" card now spans every enabled category, not just
// appointments. This projection MIRRORS composeFeedEvents exactly (same enabled-set
// + window filtering, same detail-resolved summaries), so the preview can never
// diverge from what a subscribed calendar receives.

export interface FeedPreviewRow {
  uid: string;
  category: FeedCategory;
  dateKey: string; // "YYYY-MM-DD" for grouping/sorting
  dateLabel: string; // "Fri, Jul 10, 2026"
  timeLabel: string | null; // wall-clock time for a timed appointment, else null
  summary: string;
  location: string | null;
  cancelled: boolean;
  hasReminders: boolean;
}

export function composeFeedPreviewRows(input: {
  appointments: readonly AppointmentLike[];
  signals: readonly UpcomingSignalLike[];
  today: string;
  tz: string;
  options: FeedOptions;
}): FeedPreviewRow[] {
  const { appointments, signals, today, tz, options } = input;
  const enabled = new Set(options.categories);
  const rows: FeedPreviewRow[] = [];

  if (enabled.has("appointment")) {
    const selected = selectFeedAppointments(appointments, {
      today,
      pastWindowDays: options.pastWindowDays,
      futureWindowDays: options.futureWindowDays,
    });
    for (const a of selected) {
      const base = appointmentToPreviewRow(a, { tz, detail: options.detail });
      rows.push({
        uid: base.uid,
        category: "appointment",
        dateKey: a.scheduled_at.slice(0, 10),
        dateLabel: base.dateLabel,
        timeLabel: base.timeLabel,
        summary: base.summary,
        location: base.location,
        cancelled: base.cancelled,
        // The global reminder toggle can strip alarms from an otherwise-scheduled event.
        hasReminders: options.reminders && base.hasReminders,
      });
    }
  }

  for (const s of signals) {
    if (s.domain === "appointment") continue;
    if (!enabled.has(s.domain)) continue;
    const dateKey = (s.dueDate ?? today).slice(0, 10);
    if (
      !withinWindow(
        dateKey,
        today,
        options.pastWindowDays,
        options.futureWindowDays
      )
    )
      continue;
    const ev = upcomingSignalToIcsEvent(s, {
      today,
      detail: options.detail,
      reminders: options.reminders,
    });
    rows.push({
      uid: ev.uid,
      category: s.domain,
      dateKey,
      dateLabel: formatPreviewDate(dateKey),
      timeLabel: null,
      summary: ev.summary,
      location: null,
      cancelled: false,
      hasReminders: ev.alarms,
    });
  }

  rows.sort(
    (x, y) => x.dateKey.localeCompare(y.dateKey) || x.uid.localeCompare(y.uid)
  );
  return rows;
}

// ---- Consolidated (multi-profile) feed -------------------------------------
// The "family calendar": one merged feed spanning EVERY profile a login can
// access. Each profile keeps its OWN detail level, timezone, and day boundary —
// so a profile set to "minimal" still contributes only "Medical appointment" even
// when it rides in a shared feed — and every entry is labeled with the profile
// name so a subscriber can tell whose appointment it is. Pure: the caller resolves
// the per-profile settings/appointments (from live grants) and passes them in.

// One accessible profile's contribution to a consolidated feed. It carries the
// profile's OWN full feed customization (issue #473): not just the detail level but
// the enabled categories, reminder toggle, and past/future window — the same
// FeedOptions its personal feed honors. So a profile that turned on dose/refill
// categories (or narrowed its window) contributes exactly that to the family feed
// too, instead of the old appointments-only-with-detail projection. `signals` are
// its non-appointment due-signals (collected by the caller only when a non-
// appointment category is enabled; empty otherwise).
export interface ConsolidatedProfileFeed {
  profileId: number;
  profileName: string;
  options: FeedOptions; // this profile's own saved feed customization
  tz: string; // this profile's timezone
  today: string; // this profile's "today" (for the past-window cutoff)
  appts: readonly AppointmentLike[];
  signals: readonly UpcomingSignalLike[];
}

// Prefix a resolved summary with the profile name ("Ada: Medical appointment").
// Only the profile NAME is added — never PHI: at minimal detail the base summary
// is already the neutral "Medical appointment", and the subscribing login already
// knows the names of the profiles it can access. An empty/blank name is a no-op.
export function consolidatedSummary(
  profileName: string,
  summary: string
): string {
  const name = profileName.trim();
  return name ? `${name}: ${summary}` : summary;
}

// Merge every profile's feed into one chronological event list. Each profile is
// composed through the SAME pure composer its personal feed uses (composeFeedEvents),
// so its FULL customization — enabled categories, detail level, reminders, timezone,
// and window — is honored exactly (issue #473), not just its detail level. Then each
// resulting event's summary is prefixed with the profile name and its UID namespaced
// by profile id, so two profiles can never collide on a shared appointment id AND the
// merged events stay distinct from any per-profile feed the same client might also
// subscribe to.
export function selectConsolidatedFeedEvents(
  feeds: readonly ConsolidatedProfileFeed[]
): IcsEvent[] {
  const events: IcsEvent[] = [];
  for (const feed of feeds) {
    const perProfile = composeFeedEvents({
      appointments: feed.appts,
      signals: feed.signals,
      today: feed.today,
      tz: feed.tz,
      options: feed.options,
    });
    for (const ev of perProfile) {
      events.push({
        ...ev,
        uid: `fam-${feed.profileId}-${ev.uid}`,
        summary: consolidatedSummary(feed.profileName, ev.summary),
      });
    }
  }
  // Chronological merge so the serialized feed is deterministic (a calendar client
  // re-sorts anyway, but stable output keeps tests + diffs sane). Tie-break on uid.
  events.sort(
    (x, y) =>
      x.start.getTime() - y.start.getTime() || x.uid.localeCompare(y.uid)
  );
  return events;
}

// ---- Consolidated in-app preview -------------------------------------------

// A preview row carrying the owning profile plus a groupable date key, so the
// in-app family view can render a simple by-date list labeled per profile. Extends
// the per-profile preview row (same summary/location/flags the feed emits) rather
// than inventing a parallel shape.
export interface ConsolidatedPreviewRow extends CalendarFeedPreviewRow {
  profileId: number;
  profileName: string;
  dateKey: string; // "YYYY-MM-DD" for grouping/sorting
}

// Project every accessible profile's feed to consolidated preview rows, sorted
// chronologically. Mirrors selectConsolidatedFeedEvents — each profile is composed
// through the SAME composeFeedPreviewRows its personal preview uses, so its full
// customization (categories/detail/reminders/window, issue #473) is reflected — so
// the in-app family preview can never diverge from what the family feed serves.
export function selectConsolidatedPreviewRows(
  feeds: readonly ConsolidatedProfileFeed[]
): ConsolidatedPreviewRow[] {
  const rows: (ConsolidatedPreviewRow & { sortKey: string })[] = [];
  for (const feed of feeds) {
    const perProfile = composeFeedPreviewRows({
      appointments: feed.appts,
      signals: feed.signals,
      today: feed.today,
      tz: feed.tz,
      options: feed.options,
    });
    for (const base of perProfile) {
      rows.push({
        uid: `fam-${feed.profileId}-${base.uid}`,
        dateLabel: base.dateLabel,
        timeLabel: base.timeLabel,
        summary: base.summary,
        location: base.location,
        cancelled: base.cancelled,
        hasReminders: base.hasReminders,
        profileId: feed.profileId,
        profileName: feed.profileName,
        dateKey: base.dateKey,
        sortKey: base.dateKey,
      });
    }
  }
  rows.sort(
    (x, y) => x.sortKey.localeCompare(y.sortKey) || x.uid.localeCompare(y.uid)
  );
  // Drop the internal sort key from the public shape.
  return rows.map(({ sortKey: _sortKey, ...r }) => r);
}

// A date bucket of consolidated preview rows (for the grouped by-date list).
export interface ConsolidatedDateGroup {
  dateKey: string; // "YYYY-MM-DD"
  dateLabel: string; // "Fri, Jul 10, 2026"
  rows: ConsolidatedPreviewRow[];
}

// Group already-sorted consolidated rows by calendar date, preserving order. Pure
// and deterministic so the by-date rendering is unit-tested without a DOM.
export function groupConsolidatedPreviewRows(
  rows: readonly ConsolidatedPreviewRow[]
): ConsolidatedDateGroup[] {
  const groups: ConsolidatedDateGroup[] = [];
  const byKey = new Map<string, ConsolidatedDateGroup>();
  for (const r of rows) {
    let g = byKey.get(r.dateKey);
    if (!g) {
      g = { dateKey: r.dateKey, dateLabel: r.dateLabel, rows: [] };
      byKey.set(r.dateKey, g);
      groups.push(g);
    }
    g.rows.push(r);
  }
  groups.sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  return groups;
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
