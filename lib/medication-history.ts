// Pure medication history / lifecycle logic. No DB or
// network — everything here is a pure function of its inputs so it's unit-tested
// in lib/__tests__/medication-history.test.ts. The DB reads/writes live in the
// query layer + server actions; they call into these helpers for validation,
// current-vs-past partitioning, course-state derivation, and timeline shaping.

import { daysBetweenDateStr } from "./date";
import type { TimelineEvent } from "./timeline-format";
import type {
  MedStopReason,
  MedicationCourse,
  MedicationSideEffect,
  SideEffectSeverity,
  Supplement,
} from "./types";

// Prescriber / pharmacy / Rx meta line (issue #313, deduped from the medicine
// card + editable row). Builds the middot-joined "Dr. X · Pharmacy · Rx N ·
// Provider" line, stripping a leading "Dr."/"Rx" the user may have typed into
// the free-text field so it isn't doubled. Empty parts drop out; an item with no
// medication metadata yields "". Pure so both surfaces (and any future one) format
// the identical line.
export function medicationMetaLine(
  item: Pick<
    Supplement,
    "prescriber" | "pharmacy" | "rx_number" | "provider_name"
  >
): string {
  return [
    item.prescriber && `Dr. ${item.prescriber.replace(/^dr\.?\s*/i, "")}`,
    item.pharmacy,
    item.rx_number && `Rx ${item.rx_number.replace(/^rx\s*/i, "")}`,
    item.provider_name,
  ]
    .filter(Boolean)
    .join(" · ");
}

// ---- stop_reason (controlled vocabulary) ----

export const STOP_REASONS: MedStopReason[] = [
  "side_effect",
  "ineffective",
  "completed_course",
  "switched",
  "provider_discontinued",
  "cost",
  "other",
];

export const STOP_REASON_LABELS: Record<MedStopReason, string> = {
  side_effect: "Side effect",
  ineffective: "Not effective",
  completed_course: "Completed course",
  switched: "Switched medication",
  provider_discontinued: "Provider discontinued",
  cost: "Cost",
  other: "Other",
};

export function isStopReason(v: unknown): v is MedStopReason {
  return typeof v === "string" && STOP_REASONS.includes(v as MedStopReason);
}

// Normalize an untrusted stop_reason: a valid member passes through, anything
// else (blank, garbage) folds to 'other' — a stop always records SOME reason so
// a discontinued med never has a dangling null reason. Free-text detail for the
// reason lives separately in the course notes.
export function normalizeStopReason(v: unknown): MedStopReason {
  return isStopReason(v) ? v : "other";
}

export function stopReasonLabel(v: MedStopReason | null | undefined): string {
  return v ? STOP_REASON_LABELS[v] : "Stopped";
}

// ---- severity (controlled vocabulary, optional) ----

export const SIDE_EFFECT_SEVERITIES: SideEffectSeverity[] = [
  "mild",
  "moderate",
  "severe",
];

export const SEVERITY_LABELS: Record<SideEffectSeverity, string> = {
  mild: "Mild",
  moderate: "Moderate",
  severe: "Severe",
};

export function isSeverity(v: unknown): v is SideEffectSeverity {
  return (
    typeof v === "string" &&
    SIDE_EFFECT_SEVERITIES.includes(v as SideEffectSeverity)
  );
}

// Severity is optional (null allowed): a valid member passes through, everything
// else — including a blank "unspecified" choice — becomes null.
export function normalizeSeverity(v: unknown): SideEffectSeverity | null {
  return isSeverity(v) ? v : null;
}

// ---- course-state derivation ----

// A course is "open" (the med is currently being taken under it) exactly when it
// has no stop date.
export function isCourseOpen(c: MedicationCourse): boolean {
  return c.stopped_on == null;
}

// Chronological order (oldest first). started_on is the primary key; a null
// started_on sorts last within its group, and id breaks ties so the order is
// stable across equal dates.
export function sortCourses(courses: MedicationCourse[]): MedicationCourse[] {
  return [...courses].sort((a, b) => {
    const as = a.started_on ?? "";
    const bs = b.started_on ?? "";
    if (as !== bs) return as < bs ? -1 : 1;
    return a.id - b.id;
  });
}

// The current (open) course for a med, if any. A well-formed med has at most one
// open course; if several are somehow open, the latest-started wins.
export function currentCourse(
  courses: MedicationCourse[]
): MedicationCourse | undefined {
  const open = sortCourses(courses).filter(isCourseOpen);
  return open.length ? open[open.length - 1] : undefined;
}

// Whether a medication is "current" (currently being taken). intake_items.active
// is the AUTHORITATIVE source of truth — it's the flag scheduling/reminders read,
// and the lifecycle actions maintain the invariant active=1 ⇔ an open course. We
// key the display off `active` (not off open-course presence) so the Current/Past
// split can never contradict scheduling, even if a course row somehow desyncs.
// `courses` is accepted so a caller with only the course rows (e.g. a test) can
// fall back to open-course presence; when both agree — as the invariant
// guarantees — the result is identical.
export function isMedicationCurrent(med: Supplement): boolean;
export function isMedicationCurrent(courses: MedicationCourse[]): boolean;
export function isMedicationCurrent(
  arg: Supplement | MedicationCourse[]
): boolean {
  if (Array.isArray(arg)) return arg.some(isCourseOpen);
  return arg.active === 1;
}

// Whole-day span of a course (inclusive of the start day). An open course runs to
// `todayStr`. Returns null when the start date is missing/unparseable.
export function courseDurationDays(
  course: MedicationCourse,
  todayStr: string
): number | null {
  if (!course.started_on) return null;
  const end = course.stopped_on ?? todayStr;
  const between = daysBetweenDateStr(course.started_on, end);
  return between == null ? null : Math.max(0, between) + 1;
}

// ---- current-vs-past partition ----

export interface MedicationWithHistory {
  med: Supplement;
  courses: MedicationCourse[];
  sideEffects: MedicationSideEffect[];
}

// Split a list of medications (each with its courses + side effects) into the
// Current group and the Past/discontinued group. The split keys off the
// authoritative intake_items.active flag (see isMedicationCurrent) so the display
// tracks scheduling exactly. Within each group the caller decides final ordering;
// here Current is name-sorted and Past is ordered by most-recent activity (latest
// course date) first, so the freshly-stopped med is at the top of the past list.
export function partitionMedications(items: MedicationWithHistory[]): {
  current: MedicationWithHistory[];
  past: MedicationWithHistory[];
} {
  const current: MedicationWithHistory[] = [];
  const past: MedicationWithHistory[] = [];
  for (const item of items) {
    if (isMedicationCurrent(item.med)) current.push(item);
    else past.push(item);
  }
  current.sort((a, b) => a.med.name.localeCompare(b.med.name));
  past.sort((a, b) => {
    const ad = latestCourseDate(a.courses);
    const bd = latestCourseDate(b.courses);
    if (ad !== bd) return ad < bd ? 1 : -1; // most recent first
    return a.med.name.localeCompare(b.med.name);
  });
  return { current, past };
}

// The most recent date touched by any of a med's courses (stopped_on preferred,
// else started_on), for ordering the past list. Empty string when unknown.
function latestCourseDate(courses: MedicationCourse[]): string {
  let latest = "";
  for (const c of courses) {
    const d = c.stopped_on ?? c.started_on ?? "";
    if (d > latest) latest = d;
  }
  return latest;
}

// Count of unresolved side effects, for the Past-row summary badge.
export function unresolvedCount(sideEffects: MedicationSideEffect[]): number {
  return sideEffects.filter((s) => !s.resolved).length;
}

// ---- timeline shaping ----

// One course row projected for the timeline, with the med name resolved and any
// linked side effects summarized (the DB layer joins these; this stays pure).
export interface CourseEventRow {
  courseId: number;
  medName: string;
  startedOn: string | null;
  stoppedOn: string | null;
  stopReason: MedStopReason | null;
  notes: string | null;
  // A short human summary of side effects linked to this course's stop (e.g.
  // "Nausea, Headache"), or null.
  sideEffectSummary?: string | null;
}

// Project course rows into timeline events: a "Started" event on started_on and,
// when the course is closed, a "Stopped" event on stopped_on carrying the reason
// (and any linked side effect). Rows with no usable date are skipped. Category is
// the existing "medication" bucket so no timeline category enum change is needed.
export function medicationCourseEvents(
  rows: CourseEventRow[]
): TimelineEvent[] {
  const events: TimelineEvent[] = [];
  for (const r of rows) {
    if (r.startedOn) {
      events.push({
        id: `med-course-start:${r.courseId}`,
        date: r.startedOn,
        category: "medication",
        title: `Started ${r.medName}`,
        subtitle: "Medication started",
        detail: r.notes,
        href: "/medicine",
        tone: "good",
      });
    }
    if (r.stoppedOn) {
      const reason = stopReasonLabel(r.stopReason);
      const subtitleParts = [reason];
      if (r.sideEffectSummary) subtitleParts.push(r.sideEffectSummary);
      events.push({
        id: `med-course-stop:${r.courseId}`,
        date: r.stoppedOn,
        category: "medication",
        title: `Stopped ${r.medName}`,
        subtitle: subtitleParts.join(" — "),
        detail: r.notes,
        href: "/medicine",
        tone: r.stopReason === "side_effect" ? "warn" : "default",
      });
    }
  }
  return events;
}
