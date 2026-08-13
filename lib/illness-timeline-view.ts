// Authenticated illness-timeline composition. The public/share assembly deliberately
// contains only symptoms, temperatures, and doses; this pure adapter adds care events
// for the logged-in episode page, then groups the combined ledger by day.

import type { AppointmentStatus } from "./types";
import type { AppRoute } from "./hrefs";
import { encounterHref, medicationHref } from "./hrefs";
import type { IllnessTimelineEvent } from "./illness-episode-format";
import type { EpisodeInRangeEvents } from "./illness-episode-events";

export type IllnessCareTimelineEvent = {
  kind: "encounter" | "appointment" | "course" | "document";
  id: string;
  date: string;
  time: string | null;
  time24: string | null;
  label: string;
  detail: string;
  href?: AppRoute;
};

// ── What an appointment row on a care timeline may CLAIM (#2136) ─────────────
//
// The row said "Appointment · «title» scheduled" for every status, so a visit the
// user cancelled read on the illness record as care that took place. The row itself
// is real history and stays — it is what the line asserts that was wrong, the same
// posture `hasNoCurrentReading` takes one domain over: keep the value, fix the claim.
//
// So the STATUS is the label. Nothing here is a filter and nothing is hidden; a reader
// scanning the day column sees "Appointment cancelled" and knows the gap in care is a
// gap, not a visit they have forgotten.
const APPOINTMENT_LINES: Record<
  AppointmentStatus,
  { label: string; untitled: string }
> = {
  scheduled: { label: "Appointment", untitled: "Appointment scheduled" },
  completed: { label: "Appointment", untitled: "Appointment attended" },
  cancelled: {
    label: "Appointment cancelled",
    // The title is what a titled row shows, so the untitled fallback carries the fact
    // instead — never the bare word "Appointment", which is the claim being retired.
    untitled: "This visit did not happen",
  },
};

// The label + detail one appointment contributes. Exported for the pin in
// lib/__tests__/illness-timeline-view.test.ts; the timeline is its only caller.
export function appointmentTimelineLine(appointment: {
  title: string | null;
  status: AppointmentStatus;
}): { label: string; detail: string } {
  const line = APPOINTMENT_LINES[appointment.status];
  return { label: line.label, detail: appointment.title || line.untitled };
}

export type IllnessTimelineDisplayEvent =
  IllnessTimelineEvent | IllnessCareTimelineEvent;

export interface IllnessTimelineDayGroup {
  date: string;
  events: IllnessTimelineDisplayEvent[];
}

// ── The History chips, and which one the page OPENS on (#2612) ───────────────
//
// The chips themselves are not new and nothing here removes one or hides a row.
// What moved is the ENTRY POINT. `assembleIllnessEpisode` gathers every
// `may`-obligation intake logged inside the window — deliberately, since that is
// where PRN illness care lives — and on a profile whose routine stack is ALSO
// filed `may` (creatine, whey, iron, a calcium tablet) that is 8–10 identically
// shaped dose rows a day against 2–5 symptom and temperature rows. So the page
// opened on the routine ledger and the illness story scrolled off the phone: an
// active 4-day episode measured 4556px against 2631px for the same profile
// resolved.
//
// The judgement made here is a PRESENTATION one, and only that. Distinguishing
// "episode-relevant" intake from the routine stack in the DATA is a different,
// owner-level question (it would change the chart lane, the headline and the share
// payload); this file does not attempt it. The dose rows are not noise in general
// — a fever episode's ibuprofen IS the care — so:
//
//   • `illness` is a UNION of two existing chips (symptoms + temperature), offered
//     only when it is genuinely wider than either, so no episode gets two chips
//     that select the same rows;
//   • it leads ONLY when the dilution is real — the medication rows outnumber the
//     illness rows they would be read against — and the page opens on "All"
//     exactly as before otherwise;
//   • it never leads when the strip is not rendered, because a default the reader
//     cannot undo is a trap rather than a default.
export type IllnessTimelineFilter =
  | "all"
  | "illness"
  | "symptoms"
  | "temperature"
  | "medications"
  | "care";

export const ILLNESS_TIMELINE_FILTERS: readonly {
  value: IllnessTimelineFilter;
  label: string;
}[] = [
  { value: "all", label: "All" },
  { value: "illness", label: "Illness" },
  { value: "symptoms", label: "Symptoms" },
  { value: "temperature", label: "Temperature" },
  { value: "medications", label: "Meds" },
  { value: "care", label: "Care" },
];

export function matchesIllnessTimelineFilter(
  event: IllnessTimelineDisplayEvent,
  filter: IllnessTimelineFilter
): boolean {
  switch (filter) {
    case "all":
      return true;
    case "illness":
      return event.kind === "symptom" || event.kind === "temperature";
    case "symptoms":
      return event.kind === "symptom";
    case "temperature":
      return event.kind === "temperature";
    case "medications":
      return event.kind === "medication" || event.kind === "course";
    case "care":
      return ["encounter", "appointment", "document"].includes(event.kind);
  }
}

// The chips this episode's ledger can actually offer. "All" always; a narrowing
// chip only when it selects something; `illness` only when BOTH of its halves are
// present (otherwise the single chip already IS the illness view).
export function availableIllnessTimelineFilters(
  groups: readonly IllnessTimelineDayGroup[]
): { value: IllnessTimelineFilter; label: string }[] {
  const events = groups.flatMap((group) => group.events);
  const has = (filter: IllnessTimelineFilter) =>
    events.some((event) => matchesIllnessTimelineFilter(event, filter));
  return ILLNESS_TIMELINE_FILTERS.filter(({ value }) => {
    if (value === "all") return true;
    if (value === "illness") return has("symptoms") && has("temperature");
    return has(value);
  }).map((option) => ({ ...option }));
}

// Below this many offered chips the strip does not render at all ("All" plus one
// other chip select the same rows), so there would be no way back from a narrowed
// default. Shared with the component so the two cannot disagree.
export const ILLNESS_TIMELINE_MIN_CHIPS = 3;

export function defaultIllnessTimelineFilter(
  groups: readonly IllnessTimelineDayGroup[]
): IllnessTimelineFilter {
  const available = availableIllnessTimelineFilters(groups);
  if (available.length < ILLNESS_TIMELINE_MIN_CHIPS) return "all";
  const events = groups.flatMap((group) => group.events);
  const count = (filter: IllnessTimelineFilter) =>
    events.filter((event) => matchesIllnessTimelineFilter(event, filter)).length;
  // The narrowest offered chip that still carries the whole illness signal.
  const lead: IllnessTimelineFilter | null = available.some(
    (option) => option.value === "illness"
  )
    ? "illness"
    : count("symptoms") > 0
      ? "symptoms"
      : count("temperature") > 0
        ? "temperature"
        : null;
  if (!lead) return "all";
  return count("medications") > count(lead) ? lead : "all";
}

export function illnessCareTimelineEvents(
  care: EpisodeInRangeEvents
): IllnessCareTimelineEvent[] {
  return [
    ...care.encounters.map((event) => ({
      kind: "encounter" as const,
      id: `encounter:${event.id}`,
      date: event.date.slice(0, 10),
      time: null,
      time24: null,
      label: event.type || "Visit",
      detail: event.reason || "Encounter recorded",
      href: encounterHref(event.id),
    })),
    ...care.appointments.map((event) => {
      // The row's own halves (#2234) — no string sniffing left to do.
      return {
        kind: "appointment" as const,
        id: `appointment:${event.id}`,
        date: event.date,
        time: event.timeOfDay,
        time24: event.timeOfDay,
        ...appointmentTimelineLine(event),
        href: "/appointments" as AppRoute,
      };
    }),
    ...care.courses.map((event) => ({
      kind: "course" as const,
      id: `course:${event.id}`,
      date: event.startedOn.slice(0, 10),
      time: null,
      time24: null,
      label: "Medication started",
      detail: event.name,
      href: medicationHref(event.itemId),
    })),
    ...care.documents.map((event) => ({
      kind: "document" as const,
      id: `document:${event.id}`,
      date: event.date.slice(0, 10),
      time: null,
      time24: null,
      label: event.docType || "Document",
      detail: event.filename,
    })),
  ];
}

export function groupIllnessTimelineEvents(
  episodeEvents: IllnessTimelineEvent[],
  care?: EpisodeInRangeEvents
): IllnessTimelineDayGroup[] {
  const events: IllnessTimelineDisplayEvent[] = [
    ...episodeEvents,
    ...(care ? illnessCareTimelineEvents(care) : []),
  ].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      (a.time24 ?? "99:99").localeCompare(b.time24 ?? "99:99") ||
      a.label.localeCompare(b.label)
  );
  const groups: IllnessTimelineDayGroup[] = [];
  for (const event of events) {
    const current = groups.at(-1);
    if (!current || current.date !== event.date) {
      groups.push({ date: event.date, events: [event] });
    } else {
      current.events.push(event);
    }
  }
  return groups;
}
