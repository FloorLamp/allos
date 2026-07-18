import { describe, expect, it } from "vitest";
import type { IllnessTimelineEvent } from "@/lib/illness-episode-format";
import type { EpisodeInRangeEvents } from "@/lib/illness-episode-events";
import {
  groupIllnessTimelineEvents,
  illnessCareTimelineEvents,
} from "@/lib/illness-timeline-view";

const care: EpisodeInRangeEvents = {
  encounters: [
    {
      id: 7,
      date: "2026-07-16",
      type: "Urgent care",
      reason: "Persistent cough",
    },
  ],
  appointments: [
    {
      id: 8,
      scheduledAt: "2026-07-16 10:30:00",
      title: "Follow-up",
    },
  ],
  courses: [
    { id: 9, itemId: 11, name: "Example medication", startedOn: "2026-07-17" },
  ],
  documents: [
    {
      id: 10,
      filename: "synthetic-results.pdf",
      docType: "Lab results",
      date: "2026-07-17",
    },
  ],
  total: 4,
};

describe("authenticated illness timeline composition", () => {
  it("normalizes care events without adding them to the public assembly", () => {
    expect(illnessCareTimelineEvents(care)).toMatchObject([
      {
        kind: "encounter",
        date: "2026-07-16",
        label: "Urgent care",
        detail: "Persistent cough",
        href: "/encounters/7",
      },
      {
        kind: "appointment",
        date: "2026-07-16",
        time: "10:30",
        detail: "Follow-up",
        href: "/appointments",
      },
      {
        kind: "course",
        date: "2026-07-17",
        detail: "Example medication",
        href: "/medications/11",
      },
      {
        kind: "document",
        date: "2026-07-17",
        label: "Lab results",
      },
    ]);
  });

  it("groups mixed episode and care events by day and time", () => {
    const episodeEvents: IllnessTimelineEvent[] = [
      {
        kind: "symptom",
        id: "cough:2026-07-16",
        date: "2026-07-16",
        time: null,
        time24: null,
        label: "Cough",
        detail: "Moderate",
        symptom: "cough",
        severity: 2,
        note: null,
      },
      {
        kind: "temperature",
        id: 12,
        date: "2026-07-16",
        time: "08:00",
        time24: "08:00",
        label: "Temperature",
        detail: "101.2",
        degF: 101.2,
        flag: "high",
      },
    ];
    const groups = groupIllnessTimelineEvents(episodeEvents, care);
    expect(groups.map((group) => group.date)).toEqual([
      "2026-07-16",
      "2026-07-17",
    ]);
    expect(groups[0].events.map((event) => event.kind)).toEqual([
      "temperature",
      "appointment",
      "symptom",
      "encounter",
    ]);
  });
});
