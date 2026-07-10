import { isRealIsoDate, shiftDateStr, zonedDateParts } from "./date";

export const TIMELINE_CATEGORIES = [
  "activity",
  "body",
  "medical",
  "document",
  "medication",
  "immunization",
  "condition",
  "allergy",
  "visit",
  "goal",
  "insight",
  "milestone",
  "protocol",
] as const;

export type TimelineCategory = (typeof TIMELINE_CATEGORIES)[number];
export type TimelineSearchParam = string | string[] | undefined;

export interface TimelineEvent {
  id: string;
  date: string;
  category: TimelineCategory;
  title: string;
  subtitle?: string | null;
  detail?: string | null;
  href?: string | null;
  sortTime?: string | null;
  tone?: "default" | "good" | "warn" | "bad";
  meta?: string[];
  detailItems?: {
    label: string;
    value: string;
    unit?: string | null;
    flag?: string | null;
  }[];
  iconType?: string | null;
  iconTitle?: string | null;
  // Structured component/sport names (e.g. Strava's canonical "Cycling"),
  // matched before iconTitle so an imported ride icons as a bike.
  iconSportNames?: string[] | null;
}

export interface TimelineDay {
  date: string;
  events: TimelineEvent[];
}

export function timelineCategoryLabel(category: TimelineCategory): string {
  switch (category) {
    case "activity":
      return "Activity";
    case "body":
      return "Body";
    case "medical":
      return "Medical";
    case "document":
      return "Document";
    case "medication":
      return "Medication";
    case "immunization":
      return "Immunization";
    case "condition":
      return "Condition";
    case "allergy":
      return "Allergy";
    case "visit":
      return "Visit";
    case "goal":
      return "Goal";
    case "insight":
      return "Insight";
    case "milestone":
      return "Milestone";
    case "protocol":
      return "Protocol";
  }
}

// Timeline events for a protocol: a "Started" entry on start_date and, when the
// protocol has ended, an "Ended" entry on end_date. Pure — the DB layer selects
// the rows and this shapes them (mirrors medicationCourseEvents), so start/end
// surface on the Timeline like any other dated thing.
export function protocolTimelineEvents(
  rows: {
    id: number;
    name: string;
    start_date: string;
    end_date: string | null;
  }[]
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const r of rows) {
    events.push({
      id: `protocol-start:${r.id}`,
      date: r.start_date,
      category: "protocol",
      title: `Started ${r.name}`,
      subtitle: "Protocol started",
      href: `/protocols/${r.id}`,
      tone: "good",
    });
    if (r.end_date) {
      events.push({
        id: `protocol-end:${r.id}`,
        date: r.end_date,
        category: "protocol",
        title: `Ended ${r.name}`,
        subtitle: "Protocol ended",
        href: `/protocols/${r.id}`,
        tone: "default",
      });
    }
  }
  return events;
}

function firstTimelineParam(value: TimelineSearchParam): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export function timelineCategoryFromParam(
  value: TimelineSearchParam
): TimelineCategory | undefined {
  const first = firstTimelineParam(value);
  return TIMELINE_CATEGORIES.includes(first as TimelineCategory)
    ? (first as TimelineCategory)
    : undefined;
}

export function timelineDateFromParam(
  value: TimelineSearchParam
): string | undefined {
  const trimmed = firstTimelineParam(value)?.trim();
  return trimmed && isRealIsoDate(trimmed) ? trimmed : undefined;
}

export function sortTimelineEvents(events: TimelineEvent[]): TimelineEvent[] {
  return [...events].sort((a, b) => {
    if (a.date !== b.date) return a.date < b.date ? 1 : -1;
    const at = a.sortTime ?? "";
    const bt = b.sortTime ?? "";
    if (at !== bt) return at < bt ? 1 : -1;
    return a.id.localeCompare(b.id);
  });
}

export function groupTimelineDays(events: TimelineEvent[]): TimelineDay[] {
  const days: TimelineDay[] = [];
  const byDate = new Map<string, TimelineDay>();
  for (const event of sortTimelineEvents(events)) {
    let day = byDate.get(event.date);
    if (!day) {
      day = { date: event.date, events: [] };
      byDate.set(event.date, day);
      days.push(day);
    }
    day.events.push(event);
  }
  return days;
}

export function compactList(items: string[], max = 3): string {
  const clean = items.map((i) => i.trim()).filter(Boolean);
  if (clean.length <= max) return clean.join(", ");
  return `${clean.slice(0, max).join(", ")} +${clean.length - max} more`;
}

export function journalActivityHref(activityId: number): string {
  return `/training?tab=log#activity-${activityId}`;
}

export function normalizeTimelineRange(
  from?: string,
  to?: string
): { from?: string; to?: string } {
  if (from && to && from > to) return { from: to, to: from };
  return { from, to };
}

// ---------------------------------------------------------------------------
// Shared date-range vocabulary. The Timeline and the Trends hub both drive their
// charts from the SAME from/to window and the SAME quick-range pills, so the
// definitions live here (pure) and both surfaces render them through
// components/DateRangeControl.
// ---------------------------------------------------------------------------

export interface DateRange {
  from?: string;
  to?: string;
}

export interface QuickRange {
  label: string;
  from: string;
  to: string;
}

// The quick-range pills offered by both the Timeline and Trends: last 7 / 30 / 90
// days, each ending on `todayStr` (today inclusive). Kept in one place so the two
// surfaces can never drift apart. Distances match what the Timeline shipped with
// (6 / 29 / 89 days back = 7 / 30 / 90 inclusive days).
export function quickRanges(todayStr: string): QuickRange[] {
  return [
    { label: "7D", from: shiftDateStr(todayStr, -6), to: todayStr },
    { label: "30D", from: shiftDateStr(todayStr, -29), to: todayStr },
    { label: "90D", from: shiftDateStr(todayStr, -89), to: todayStr },
  ];
}

// Whether `range` exactly matches a quick-range pill (so the pill renders active):
// both bounds line up with its from/to.
export function isQuickRangeActive(range: DateRange, qr: QuickRange): boolean {
  return range.from === qr.from && range.to === qr.to;
}

// Whether `range` is the open "All time" window (no bounds set) — the state the
// "All time" / "Clear dates" affordance returns to.
export function isAllTimeRange(range: DateRange): boolean {
  return !range.from && !range.to;
}

// ---------------------------------------------------------------------------
// Pure event-shaping helpers (extracted from lib/timeline.ts so they can be unit
// tested without a DB). timeline.ts imports these to build TimelineEvents.
// ---------------------------------------------------------------------------

// Tone for a single biomarker result flag: out-of-range reads as "bad", a
// non-optimal read as "warn", everything else neutral.
export function flagTone(
  flag: string | null | undefined
): TimelineEvent["tone"] {
  if (flag === "high" || flag === "low" || flag === "abnormal") return "bad";
  if (flag?.startsWith("non-optimal")) return "warn";
  return "default";
}

// Tone for a grouped panel from its abnormal / non-optimal counts.
export function countTone(
  abnormalCount: number,
  nonoptimalCount: number
): TimelineEvent["tone"] {
  return abnormalCount ? "bad" : nonoptimalCount ? "warn" : "default";
}

// Destination for a grouped medical/lab panel event: the source document when
// known, else a single-biomarker chart when the panel is one marker, else the
// biomarkers index.
export function medicalRecordHref(
  documentId: number | null,
  names: string[],
  firstName: string | null
): string {
  if (documentId != null) return `/import/${documentId}`;
  if (names.length === 1 && firstName) {
    return `/biomarkers/view?name=${encodeURIComponent(firstName)}`;
  }
  return "/biomarkers";
}

// Parse the "label::value::unit::flag" pipe-delimited GROUP_CONCAT payloads the
// timeline SQL builds for expandable result/dose detail rows. Returns undefined
// when nothing usable parses out (so the caller can omit the field).
export function parseDetailItems(
  value: string | null | undefined
): TimelineEvent["detailItems"] {
  const items = (value ?? "")
    .split("||")
    .map((part) => {
      const [label, itemValue, unit, flag] = part.split("::");
      const unitValue = unit?.trim();
      const flagValue = flag?.trim();
      return {
        label: label?.trim() ?? "",
        value: itemValue?.trim() ?? "",
        ...(unitValue ? { unit: unitValue } : {}),
        ...(flagValue ? { flag: flagValue } : {}),
      };
    })
    .filter((item) => item.label && item.value);
  return items.length > 0 ? items : undefined;
}

// Parse a DB timestamp stored as UTC — SQLite `datetime('now')` yields
// "YYYY-MM-DD HH:MM:SS" with no zone designator — into a Date. Also tolerates ISO
// strings that already carry a zone. Returns null for empty/unparseable input.
export function parseUtcStamp(value: string | null | undefined): Date | null {
  if (!value) return null;
  const s = value.trim();
  if (!s) return null;
  const iso = s.includes("T") ? s : s.replace(" ", "T");
  const hasZone = /(?:[Zz]|[+-]\d{2}:?\d{2})$/.test(iso);
  const d = new Date(hasZone ? iso : `${iso}Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

// Calendar date (YYYY-MM-DD) of a UTC-stored created_at/uploaded_at timestamp, in
// the profile's timezone — so created-at-fallback timeline events (documents,
// conditions, allergies, goals) land on the same local day the rest of the app
// attributes them to, instead of a raw UTC slice that can be off-by-one near
// midnight.
export function dateFromCreatedAt(
  value: string | null | undefined,
  tz: string
): string | null {
  const d = parseUtcStamp(value);
  return d ? zonedDateParts(tz, d).date : null;
}

// Wall-clock HH:MM of a UTC-stored timestamp in the profile's timezone, used only
// to order same-day created-at events (sortTime).
export function timeFromCreatedAt(
  value: string | null | undefined,
  tz: string
): string | null {
  const d = parseUtcStamp(value);
  return d ? zonedDateParts(tz, d).hhmm : null;
}
