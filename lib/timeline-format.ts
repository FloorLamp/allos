import { isRealIsoDate, shiftDateStr, zonedDateParts } from "./date";
import { OTHER_PANEL, panelLabel, parsePanelId } from "./biomarker-panels";
import {
  readingDetailHref,
  dataSectionHref,
  importHref,
  protocolHref,
  MEDICATIONS_HREF,
  type AppRoute,
} from "./hrefs";

// Tone for a single biomarker result flag: out-of-range reads as "bad", a
// non-optimal read as "warn", everything else neutral. Re-exported from the
// canonical flag classifier (issue #306) so the timeline shares the one tier
// decision (its FlagTone is a subset of TimelineEvent["tone"]).
export { flagTone } from "./reference-range";

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
  "imaging",
  "goal",
  "insight",
  "milestone",
  "protocol",
  "symptom",
  "illness",
  "injury",
  "endurance",
  "practice",
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
  href?: AppRoute | null;
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
  // Non-causal cross-domain LINKED CONTEXT (#662): informational deep-links to
  // OTHER records this event relates to by KNOWN lineage — a visit's `linkedRefs`
  // point at the care-plan items / procedures / medications the SAME import
  // document produced. This is a reference ("also produced from this visit's
  // document"), NEVER a causal claim; the primary `href` stays the event's own
  // source record. AppRoute-typed like every internal link (#285).
  linkedRefs?: { label: string; href: AppRoute }[];
  // The event's raw LOCAL clock window (issue #1068), carried on the event so the
  // Timeline day view's intraday panel can draw it as a span from the SAME event
  // set the feed lists — one gather, two formatters, never a second per-layer
  // query. Set only where the source row genuinely has a window (activities);
  // absent everywhere else, which is exactly what data-gates the block layer. The
  // span itself is resolved by the ONE canonical `activityWindow()` computation
  // (lib/training-zones), the same one the training-zone aggregation uses.
  clockWindow?: {
    date: string;
    start_time: string | null;
    end_time: string | null;
    duration_min: number | null;
  };
}

// The DOM id of a rendered feed entry (issue #1068). The intraday panel's ticks
// and blocks link to `#<anchor>`, so tapping one scrolls the list below to that
// entry — chart as map, list as detail. Event ids carry ':' separators (and
// document/exercise names can carry anything), so everything outside the
// fragment-safe set collapses to '-'.
export function timelineEntryAnchorId(eventId: string): string {
  return `timeline-entry-${eventId.replace(/[^A-Za-z0-9_-]+/g, "-")}`;
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
    case "imaging":
      return "Imaging";
    case "goal":
      return "Goal";
    case "insight":
      return "Insight";
    case "milestone":
      return "Milestone";
    case "protocol":
      return "Protocol";
    case "symptom":
      return "Symptom";
    case "illness":
      return "Illness";
    case "injury":
      return "Injury";
    case "endurance":
      return "Event";
    case "practice":
      return "Practice";
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
      href: protocolHref(r.id),
      tone: "good",
    });
    if (r.end_date) {
      events.push({
        id: `protocol-end:${r.id}`,
        date: r.end_date,
        category: "protocol",
        title: `Ended ${r.name}`,
        subtitle: "Protocol ended",
        href: protocolHref(r.id),
        tone: "default",
      });
    }
  }
  return events;
}

// A sibling record produced by the SAME import document as a visit (#662). The DB
// layer gathers these by shared document_id; this pure shaper turns them into the
// visit event's `linkedRefs` — one deep-link per record to its domain surface (no
// per-row detail route exists for procedures/care-plan; the medication list is the
// meds home). `kind` selects the destination and prefixes the label so a mixed
// list reads unambiguously. Blank-named rows are dropped; order is preserved.
export interface VisitLinkedRow {
  kind: "procedure" | "care-plan" | "medication";
  label: string;
}

export function visitLinkedRefs(
  rows: VisitLinkedRow[]
): NonNullable<TimelineEvent["linkedRefs"]> {
  const hrefFor = (kind: VisitLinkedRow["kind"]): AppRoute =>
    kind === "procedure"
      ? "/records/history/procedures"
      : kind === "care-plan"
        ? "/records/care/overview"
        : MEDICATIONS_HREF;
  const kindLabel = (kind: VisitLinkedRow["kind"]): string =>
    kind === "procedure"
      ? "Procedure"
      : kind === "care-plan"
        ? "Care plan"
        : "Medication";
  return rows
    .filter((r) => r.label.trim())
    .map((r) => ({
      label: `${kindLabel(r.kind)}: ${r.label.trim()}`,
      href: hrefFor(r.kind),
    }));
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

export function trainingLogActivityHref(activityId: number): AppRoute {
  return `/training?tab=log#activity-${activityId}`;
}

export function normalizeTimelineRange(
  from?: string,
  to?: string
): { from?: string; to?: string } {
  if (from && to && from > to) return { from: to, to: from };
  return { from, to };
}

// "Nothing here" on the Timeline has TWO meanings and only one of them is a brand-new
// account (issue #1410). With a category pill or a date window applied, an empty feed
// is a FILTER RESULT — the reader knows why it's empty and the fix is to widen the
// filter, so the message stays the bare "No <category> events yet." it has always been.
// With neither applied, the account genuinely holds nothing and the fix is to put
// something IN it: that, and only that, earns the next-action links below.
export function isTimelineUnfiltered(
  category: TimelineCategory | undefined,
  range: DateRange
): boolean {
  return !category && !range.from && !range.to;
}

// The next actions on that base empty state — the three INGEST DOORS a timeline
// actually fills from: something you did, something you measured, something a clinic
// gave you. Deliberately not one CTA: naming only "log an activity" would tell a
// reader who came to Allos with a stack of lab PDFs the wrong thing. Every href is
// `AppRoute`, so a consolidated-away destination is a build error (#285).
export const TIMELINE_EMPTY_ACTIONS: ReadonlyArray<{
  href: AppRoute;
  label: string;
}> = [
  { href: "/training?tab=log", label: "Log an activity" },
  { href: "/trends#body", label: "Add a body metric" },
  { href: dataSectionHref("import"), label: "Import a document" },
];

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
// / 365 days, each ending on `todayStr` (today inclusive). Kept in one place so the
// two surfaces can never drift apart. Distances match what the Timeline shipped
// with (6 / 29 / 89 days back = 7 / 30 / 90 inclusive days); 1Y is 364 back = 365
// inclusive days (#1938 — a year was previously reachable only by hand-typing
// dates, so "All time" was the only option past 90 days). A fixed 365-day window
// rather than "the current calendar year": it is a TRAILING window like its
// siblings, so it never shrinks to a stub every January, and calendar arithmetic
// (shiftDateStr is UTC-anchored) keeps it exact across DST and leap days.
export function quickRanges(todayStr: string): QuickRange[] {
  return [
    { label: "7D", from: shiftDateStr(todayStr, -6), to: todayStr },
    { label: "30D", from: shiftDateStr(todayStr, -29), to: todayStr },
    { label: "90D", from: shiftDateStr(todayStr, -89), to: todayStr },
    { label: "1Y", from: shiftDateStr(todayStr, -364), to: todayStr },
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
// Trends' default window (#1485 G). TRENDS ONLY — the Timeline keeps its
// all-time default (a feed has different semantics: it reads backwards from
// today and its "load more" is the window).
// ---------------------------------------------------------------------------

// The quick-range pill the Trends surfaces open on when the URL names no window.
// All-time as the default made every slope read as a lifetime average and buried
// recent change; 90D is the shortest window that still shows a lab trend.
export const DEFAULT_TRENDS_RANGE_LABEL = "90D";

// Because the default is a REAL window rather than the absence of one, "All time"
// needs a way to say itself in a URL — an empty query string now means 90D, so
// the pill that used to clear the params would otherwise be a no-op that lands
// back on the default. `?range=all` is that sentinel: an EXPLICIT all-time window,
// as deep-linkable as any ?from/?to pair. Trends-only; the Timeline never emits it.
export const ALL_TIME_RANGE_PARAM = "range";
export const ALL_TIME_RANGE_VALUE = "all";

// The default window itself, resolved against the profile's today. Derived from
// `quickRanges` BY LABEL (not by index) so it can never drift from the pill it
// lights: a default load must render 90D active, which `isQuickRangeActive` only
// says for an exact from/to match.
export function defaultTrendsRange(todayStr: string): DateRange {
  const ranges = quickRanges(todayStr);
  const qr =
    ranges.find((q) => q.label === DEFAULT_TRENDS_RANGE_LABEL) ??
    ranges[ranges.length - 1];
  return { from: qr.from, to: qr.to };
}

// Resolve a Trends surface's window from its already-parsed params. The whole
// rule, in one place, for every Trends surface (the hub and the metric detail
// pages) — three cases, in precedence order:
//
//   1. `?range=all` — an explicit all-time window. Params always win.
//   2. Either bound set — an explicit window (a shared/bookmarked ?from/?to link,
//      a quick-range pill). Used verbatim; a partial window keeps
//      its open side open, exactly as before.
//   3. Neither — the no-param default, 90D.
//
// A URL that says something is therefore NEVER reinterpreted; only the URL that
// says nothing gained a meaning.
export function resolveTrendsRange(
  parsed: DateRange,
  todayStr: string,
  rangeParam?: string
): DateRange {
  if (rangeParam === ALL_TIME_RANGE_VALUE) return {};
  if (parsed.from || parsed.to) return parsed;
  return defaultTrendsRange(todayStr);
}

// The single-day (today) window behind the Vitals tab's "1D" pill (#1466). It is
// NOT part of the shared `quickRanges` set: on a daily-grain series a one-day
// window is a single dot — worse than useless — so only a surface that swaps to
// genuinely INTRADAY content injects it, through DateRangeControl's `extraRanges`.
export function intradayQuickRange(todayStr: string): QuickRange {
  return { label: "1D", from: todayStr, to: todayStr };
}

// Whether `range` is that single-day window — the Vitals tab's cue to swap its
// windowed daily charts for the intraday ones.
export function isIntradayRange(range: DateRange, todayStr: string): boolean {
  return isQuickRangeActive(range, intradayQuickRange(todayStr));
}

// Whether `range` is a CUSTOM window — one that no chip in the row already names:
// not "All time" and not an exact quick-range match. Two surfaces ask this same
// question and must never drift (#1455), so it lives here once:
//   • DateRangeControl opens its collapsed mobile From/To panel by default when
//     the active window is custom, so a shared ?from=/?to= URL still shows its
//     dates instead of hiding them behind the "Custom…" pill.
//   • The Trends hub + metric pages render the `rangeSummaryLabel` chip ONLY for a
//     custom window — with a preset active the chip just repeats the lit pill's
//     own label (the duplicate "All time" chip).
//
// `extraRanges` is whatever the surface injected beyond the shared set (#1466's 1D
// pill). A window one of THOSE pills names is not custom either — otherwise
// lighting 1D would also pop the "Custom…" panel open and print a summary chip
// duplicating the lit pill, the exact pair of bugs #1455 D removed.
export function isCustomRange(
  range: DateRange,
  todayStr: string,
  extraRanges: QuickRange[] = []
): boolean {
  if (isAllTimeRange(range)) return false;
  return ![...extraRanges, ...quickRanges(todayStr)].some((qr) =>
    isQuickRangeActive(range, qr)
  );
}

// ---------------------------------------------------------------------------
// Pure event-shaping helpers (extracted from lib/timeline.ts so they can be unit
// tested without a DB). timeline.ts imports these to build TimelineEvents.
// ---------------------------------------------------------------------------

// Tone for a grouped panel from its abnormal / non-optimal counts.
export function countTone(
  abnormalCount: number,
  nonoptimalCount: number
): TimelineEvent["tone"] {
  return abnormalCount ? "bad" : nonoptimalCount ? "warn" : "default";
}

// Display name for a grouped medical event (#1502). `panelId` is the normalized
// panel slug the SQL resolved from the group's canonical names; `fallback` is the
// pre-#1502 key (the stored free-text panel, else the record category). A known
// panel renders its curated label ("Lipids", "Complete blood count"); the reserved
// `other` slug — an un-canonicalized analyte with no panel to claim — keeps the
// old behavior verbatim so nothing regresses into a meaningless "Other results".
// A blank fallback (a category-less row) degrades to "Lab" rather than an empty
// title. Pure, so the same rule is testable without a DB.
export function medicalGroupLabel(
  panelId: string,
  fallback: string | null | undefined
): string {
  const known = parsePanelId(panelId);
  if (known && known !== OTHER_PANEL) return panelLabel(known);
  return fallback?.trim() || "Lab";
}

// Destination for a grouped medical/lab panel event: the source document when
// known, else a single-biomarker chart when the panel is one marker, else the
// biomarkers index.
export function clinicalObservationHref(
  documentId: number | null,
  names: string[],
  firstName: string | null
): AppRoute {
  if (documentId != null) return importHref(documentId);
  if (names.length === 1 && firstName) {
    return readingDetailHref(firstName);
  }
  return "/results/readings";
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
