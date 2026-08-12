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
