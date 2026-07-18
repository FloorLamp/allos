// Authenticated illness-timeline composition. The public/share assembly deliberately
// contains only symptoms, temperatures, and doses; this pure adapter adds care events
// for the logged-in episode page, then groups the combined ledger by day.

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

export type IllnessTimelineDisplayEvent =
  IllnessTimelineEvent | IllnessCareTimelineEvent;

export interface IllnessTimelineDayGroup {
  date: string;
  events: IllnessTimelineDisplayEvent[];
}

function appointmentParts(value: string): {
  date: string;
  time: string | null;
} {
  const normalized = value.replace(" ", "T");
  const [date, rest] = normalized.split("T");
  const time = /^\d{2}:\d{2}/.test(rest ?? "") ? rest.slice(0, 5) : null;
  return { date: date.slice(0, 10), time };
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
      const { date, time } = appointmentParts(event.scheduledAt);
      return {
        kind: "appointment" as const,
        id: `appointment:${event.id}`,
        date,
        time,
        time24: time,
        label: "Appointment",
        detail: event.title || "Appointment scheduled",
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
