// Event annotations for the Trends hub. Overlays life-events
// — medication course start/stop, scheduled appointments, and
// active-situation changes — as vertical reference-line markers on the trend /
// compare charts, so a metric move can be tied to a plausible cause.
//
// Everything here is PURE list math (shape → filter → sort → snap): the server
// helper (lib/trends-series) fetches the source rows through the existing
// PROFILE-SCOPED queries and hands them in, so no owned SQL is added and the
// scoping guard is unaffected. Unit-tested in lib/__tests__/trend-annotations.
//
// Situation history: profile_settings only stores the CURRENT active-situation
// set, so there is no dated change log to read. `diffSituations` derives the
// start/stop events from the before/after sets on each edit; lib/settings appends
// them to a per-profile JSON log (key "situation_events"), same precedent as
// trend_pins — again no owned table.

import { daysBetweenDateStr } from "./date";
import type { DateRange } from "./timeline-format";

export type AnnotationKind = "medication" | "appointment" | "situation";

// A positioned marker: an ISO date, a short human label, and the source kind that
// drives its color + the per-type toggle.
export interface TrendAnnotation {
  date: string; // YYYY-MM-DD
  label: string;
  kind: AnnotationKind;
}

// ---- Raw source inputs (already resolved by the server helper) ----

// A medication course → a "started" marker at started_on and, when closed, a
// "stopped" marker at stopped_on.
export interface MedCourseInput {
  name: string;
  startedOn: string | null;
  stoppedOn: string | null;
}

// A scheduled/completed appointment (cancelled ones are dropped upstream). `date`
// is the calendar day (scheduled_at sliced to YYYY-MM-DD).
export interface AppointmentInput {
  date: string | null;
  title: string | null;
  providerName: string | null;
}

// One active-situation change (a situation turned on or off on `date`).
export interface SituationEvent {
  date: string; // YYYY-MM-DD
  situation: string;
  change: "start" | "stop";
}

// Presentation metadata per kind: the toggle-bar label and a mid-tone color that
// stays legible on both the light and dark chart surfaces.
export const ANNOTATION_KIND_META: Record<
  AnnotationKind,
  { label: string; color: string }
> = {
  medication: { label: "Medications", color: "#3b82f6" }, // blue-500
  appointment: { label: "Appointments", color: "#f59e0b" }, // amber-500
  situation: { label: "Situations", color: "#8b5cf6" }, // violet-500
};

// Deterministic ordering so same-day markers of different kinds sort stably.
const KIND_ORDER: Record<AnnotationKind, number> = {
  medication: 0,
  appointment: 1,
  situation: 2,
};

const isDate = (v: unknown): v is string =>
  typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

function inWindow(date: string, range: DateRange): boolean {
  const { from, to } = range;
  return (!from || date >= from) && (!to || date <= to);
}

// Expand the raw source rows into positioned markers, keep only those inside the
// [from, to] window (inclusive; an open bound matches everything on that side —
// same rule as filterSeriesByRange), and sort chronologically, then by kind, then
// label so the order is stable.
export function buildAnnotations(
  input: {
    medications?: MedCourseInput[];
    appointments?: AppointmentInput[];
    situations?: SituationEvent[];
  },
  range: DateRange
): TrendAnnotation[] {
  const out: TrendAnnotation[] = [];

  for (const m of input.medications ?? []) {
    const name = m.name.trim() || "Medication";
    if (isDate(m.startedOn)) {
      out.push({
        date: m.startedOn,
        label: `${name} started`,
        kind: "medication",
      });
    }
    if (isDate(m.stoppedOn)) {
      out.push({
        date: m.stoppedOn,
        label: `${name} stopped`,
        kind: "medication",
      });
    }
  }

  for (const a of input.appointments ?? []) {
    if (!isDate(a.date)) continue;
    const label =
      (a.title && a.title.trim()) ||
      (a.providerName && a.providerName.trim()) ||
      "Appointment";
    out.push({ date: a.date, label, kind: "appointment" });
  }

  for (const s of input.situations ?? []) {
    if (!isDate(s.date)) continue;
    const name = s.situation.trim();
    if (!name) continue;
    out.push({
      date: s.date,
      label: `${name} ${s.change === "start" ? "started" : "ended"}`,
      kind: "situation",
    });
  }

  return out
    .filter((a) => inWindow(a.date, range))
    .sort(
      (x, y) =>
        x.date.localeCompare(y.date) ||
        KIND_ORDER[x.kind] - KIND_ORDER[y.kind] ||
        x.label.localeCompare(y.label)
    );
}

// The set of kinds present in a marker list — drives which toggles the UI shows
// (a toggle for a kind with no markers would be dead weight).
export function annotationKindsPresent(
  annotations: readonly TrendAnnotation[]
): AnnotationKind[] {
  const seen = new Set<AnnotationKind>();
  for (const a of annotations) seen.add(a.kind);
  return (Object.keys(KIND_ORDER) as AnnotationKind[]).filter((k) =>
    seen.has(k)
  );
}

// Keep only the markers whose kind is enabled (the per-type toggle).
export function filterAnnotationsByKind(
  annotations: readonly TrendAnnotation[],
  enabled: Partial<Record<AnnotationKind, boolean>>
): TrendAnnotation[] {
  return annotations.filter((a) => enabled[a.kind] !== false);
}

// Snap each marker to the nearest charted category date, because recharts renders
// a vertical ReferenceLine on a CATEGORY x-axis only when its x matches an actual
// data point. A marker with no dates to snap to is dropped. Ties (equidistant
// between two points) resolve to the LATER date. Returns markers in the same order.
export function snapAnnotationsToDates(
  annotations: readonly TrendAnnotation[],
  dates: readonly string[]
): TrendAnnotation[] {
  if (dates.length === 0) return [];
  const out: TrendAnnotation[] = [];
  for (const a of annotations) {
    let best: string | null = null;
    let bestDist = Infinity;
    for (const d of dates) {
      const gap = daysBetweenDateStr(a.date, d);
      if (gap == null) continue;
      const dist = Math.abs(gap);
      // <= so a later, equidistant date wins the tie (dates are ascending).
      if (dist < bestDist || (dist === bestDist && best != null && d > best)) {
        bestDist = dist;
        best = d;
      }
    }
    if (best != null) out.push({ ...a, date: best });
  }
  return out;
}

// ---- Situation-change log (stored per-profile as JSON in profile_settings) ----

// Derive the start/stop events from an active-situation edit: each newly added
// situation is a "start" on `date`, each removed one a "stop". Comparison is
// case-sensitive on the trimmed name (situations are stored trimmed + de-duped).
export function diffSituations(
  before: readonly string[],
  after: readonly string[],
  date: string
): SituationEvent[] {
  const beforeSet = new Set(before.map((s) => s.trim()).filter(Boolean));
  const afterSet = new Set(after.map((s) => s.trim()).filter(Boolean));
  const events: SituationEvent[] = [];
  for (const s of afterSet)
    if (!beforeSet.has(s)) events.push({ date, situation: s, change: "start" });
  for (const s of beforeSet)
    if (!afterSet.has(s)) events.push({ date, situation: s, change: "stop" });
  return events.sort(
    (a, b) =>
      a.change.localeCompare(b.change) || a.situation.localeCompare(b.situation)
  );
}

// Which situations were active on a GIVEN past day, reconstructed from the
// authoritative CURRENT active set plus the dated start/stop change-log (#654).
// Adherence HISTORY must reflect when a situation was actually active, not today's
// toggle applied retroactively — turning "Travel" on today must not make 25 prior
// days of a travel supplement read as due-and-missed, and turning it off must not
// erase real past misses.
//
// The state on `date` is decided by each situation's EARLIEST transition strictly
// AFTER `date`: a future "start" means it was OFF on `date` (about to turn on); a
// future "stop" means it was ON on `date` (about to turn off). With no transition
// after `date`, its state on `date` equals its CURRENT state — which is why the
// authoritative present set is the seed: a situation active since before the log
// began (no "start" event) correctly stays active across the whole window. Names
// are trimmed to match diffSituations / getActiveSituations. Pure.
export function situationsActiveOn(
  date: string,
  currentActive: Iterable<string>,
  events: readonly SituationEvent[]
): Set<string> {
  const current = new Set<string>();
  for (const s of currentActive) {
    const t = s.trim();
    if (t) current.add(t);
  }
  // Earliest transition strictly after `date`, per situation.
  const nextChange = new Map<string, "start" | "stop">();
  const nextDate = new Map<string, string>();
  for (const e of events) {
    const name = e.situation.trim();
    if (!name || !(e.date > date)) continue;
    const seen = nextDate.get(name);
    if (seen === undefined || e.date < seen) {
      nextDate.set(name, e.date);
      nextChange.set(name, e.change);
    }
  }
  const active = new Set<string>();
  for (const name of new Set<string>([...current, ...nextChange.keys()])) {
    const next = nextChange.get(name);
    const wasActive = next ? next === "stop" : current.has(name);
    if (wasActive) active.add(name);
  }
  return active;
}

// Build a per-date "situations active that day" resolver over a window, from the
// current active set + the change-log (#654). One computation the medicine page,
// the notifier's adherence strip, the weekly recap, and the digest all reuse so
// their historical dueness can never disagree about when a situation was active.
export function situationHistoryResolver(
  currentActive: Iterable<string>,
  events: readonly SituationEvent[]
): (date: string) => Set<string> {
  const current = [...currentActive];
  return (date: string) => situationsActiveOn(date, current, events);
}

// Cap on the stored situation-event log, so a chatty toggler can't bloat the blob.
// The most-recent events are kept.
export const SITUATION_LOG_CAP = 200;

// Parse the stored situation-event log defensively (any malformed/legacy shape →
// []), keeping only well-formed events. Mirrors parsePins.
export function parseSituationEvents(
  raw: string | null | undefined
): SituationEvent[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((e): SituationEvent[] => {
      if (
        e &&
        typeof e === "object" &&
        isDate((e as { date?: unknown }).date) &&
        typeof (e as { situation?: unknown }).situation === "string" &&
        ((e as { change?: unknown }).change === "start" ||
          (e as { change?: unknown }).change === "stop")
      ) {
        const ev = e as SituationEvent;
        const situation = ev.situation.trim();
        return situation
          ? [{ date: ev.date, situation, change: ev.change }]
          : [];
      }
      return [];
    });
  } catch {
    return [];
  }
}

// Append new events to the existing log and serialize, trimming to the most-recent
// SITUATION_LOG_CAP so the blob stays bounded.
export function serializeSituationEvents(
  existing: readonly SituationEvent[],
  added: readonly SituationEvent[]
): string {
  const merged = [...existing, ...added];
  const trimmed =
    merged.length > SITUATION_LOG_CAP
      ? merged.slice(merged.length - SITUATION_LOG_CAP)
      : merged;
  return JSON.stringify(trimmed);
}
