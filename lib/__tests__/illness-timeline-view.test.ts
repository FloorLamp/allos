import { describe, expect, it } from "vitest";
import type { IllnessTimelineEvent } from "@/lib/illness-episode-format";
import type { EpisodeInRangeEvents } from "@/lib/illness-episode-events";
import {
  appointmentTimelineLine,
  availableIllnessTimelineFilters,
  defaultIllnessTimelineFilter,
  groupIllnessTimelineEvents,
  ILLNESS_TIMELINE_MIN_CHIPS,
  illnessCareTimelineEvents,
  matchesIllnessTimelineFilter,
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
      date: "2026-07-16",
      timeOfDay: "10:30",
      title: "Follow-up",
      status: "scheduled",
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

// #2136: the line an appointment contributes names its STATUS. The row is not hidden
// — a cancelled visit inside an illness window is real history, and often the reason a
// gap in care exists — but it may not read as care that happened.
describe("appointmentTimelineLine (#2136)", () => {
  it("labels a cancelled appointment as cancelled, titled or not", () => {
    expect(
      appointmentTimelineLine({ title: "Follow-up", status: "cancelled" })
    ).toEqual({ label: "Appointment cancelled", detail: "Follow-up" });
    expect(
      appointmentTimelineLine({ title: null, status: "cancelled" })
    ).toEqual({
      label: "Appointment cancelled",
      detail: "This visit did not happen",
    });
  });

  it("never says 'scheduled' about a visit that is not scheduled", () => {
    // The exact defect: the fallback detail read "Appointment scheduled" for every
    // status, so a cancelled booking asserted a booking that stood.
    for (const status of ["completed", "cancelled"] as const) {
      const line = appointmentTimelineLine({ title: null, status });
      expect(line.detail).not.toContain("scheduled");
      expect(line.label).not.toContain("scheduled");
    }
  });

  it("leaves a scheduled appointment exactly as it read before", () => {
    expect(
      appointmentTimelineLine({ title: null, status: "scheduled" })
    ).toEqual({ label: "Appointment", detail: "Appointment scheduled" });
  });
});

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
        label: "Appointment",
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

// #2612: which chip the History OPENS on, and what leading with it HIDES. A
// filtered-out row is hidden, not removed — it stays in the document, prints, and
// returns on the next chip tap — but the set that gets hidden still has to be the
// right one. The Illness view drops the routine SUPPLEMENT dose rows and keeps the
// medicine given for the illness, because a 200 mg ibuprofen during a fever is
// exactly the row a reader came for.
describe("the History's default chip (#2612)", () => {
  const symptom = (date: string, key: string): IllnessTimelineEvent => ({
    kind: "symptom",
    id: `${key}:${date}`,
    date,
    time: null,
    time24: null,
    label: key,
    detail: "Moderate",
    symptom: key,
    severity: 2,
    note: null,
  });
  const temperature = (date: string): IllnessTimelineEvent => ({
    kind: "temperature",
    id: `t:${date}`,
    date,
    time: "08:00",
    time24: "08:00",
    label: "Temperature",
    detail: "101.2",
    degF: 101.2,
    flag: "high",
  });
  // A ROUTINE supplement dose — the row the Illness view exists to hide.
  type DoseEvent = Extract<IllnessTimelineEvent, { kind: "medication" }>;
  const supplementDose = (date: string, index: number): DoseEvent => ({
    kind: "medication",
    id: `s:${date}:${index}`,
    date,
    time: "07:05",
    time24: "07:05",
    timeRecorded: false,
    label: `Supplement ${index}`,
    detail: "1 serving",
    itemId: index,
    itemKind: "supplement",
    amount: "1 serving",
  });
  // The medicine given FOR the illness — the row it must never hide.
  const medicineDose = (date: string, index: number): DoseEvent => ({
    kind: "medication",
    id: `m:${date}:${index}`,
    date,
    time: "19:03",
    time24: "19:03",
    timeRecorded: false,
    label: "Ibuprofen",
    detail: "200 mg",
    itemId: 900 + index,
    itemKind: "medication",
    amount: "200 mg",
  });

  it("offers the union chip only when BOTH of its halves are present", () => {
    const bothHalves = groupIllnessTimelineEvents([
      symptom("2026-07-16", "cough"),
      temperature("2026-07-16"),
    ]);
    expect(
      availableIllnessTimelineFilters(bothHalves).map((o) => o.value)
    ).toEqual(["all", "illness", "symptoms", "temperature"]);
    // Symptoms alone: the single chip already IS the illness view, so a second
    // chip selecting the same rows would be noise.
    const symptomsOnly = groupIllnessTimelineEvents([
      symptom("2026-07-16", "cough"),
    ]);
    expect(
      availableIllnessTimelineFilters(symptomsOnly).map((o) => o.value)
    ).toEqual(["all", "symptoms"]);
  });

  it("keeps the medicine given for the illness and drops only the routine stack", () => {
    const mixed = [
      symptom("2026-07-16", "cough"),
      temperature("2026-07-16"),
      medicineDose("2026-07-16", 0),
      supplementDose("2026-07-16", 0),
    ];
    const kept = mixed.filter((event) =>
      matchesIllnessTimelineFilter(event, "illness")
    );
    expect(kept.map((event) => event.id)).toEqual([
      "cough:2026-07-16",
      "t:2026-07-16",
      "m:2026-07-16:0",
    ]);
  });

  it("keeps a dose row whose kind is unknown — the hiding rule fails towards showing the medicine", () => {
    const known = medicineDose("2026-07-16", 1);
    // A payload assembled before the gather carried `kind` — the share render, a
    // cached RSC response mid-deploy — states no kind at all.
    const unknown: DoseEvent = { ...known, itemKind: undefined };
    expect(matchesIllnessTimelineFilter(unknown, "illness")).toBe(true);
  });

  it("leads with the illness view when the routine stack outnumbers everything else", () => {
    const diluted = groupIllnessTimelineEvents([
      symptom("2026-07-16", "cough"),
      temperature("2026-07-16"),
      medicineDose("2026-07-16", 0),
      ...Array.from({ length: 8 }, (_, index) =>
        supplementDose("2026-07-16", index)
      ),
    ]);
    expect(defaultIllnessTimelineFilter(diluted)).toBe("illness");
  });

  it("stays on All when the doses ARE the illness care — nothing to hide", () => {
    // Eight ibuprofen administrations over a fever is not dilution, it is the
    // record. The Illness view would hide nothing, so it must not lead.
    const fever = groupIllnessTimelineEvents([
      symptom("2026-07-16", "cough"),
      temperature("2026-07-16"),
      ...Array.from({ length: 8 }, (_, index) =>
        medicineDose("2026-07-16", index)
      ),
    ]);
    expect(defaultIllnessTimelineFilter(fever)).toBe("all");
  });

  it("stays on All when the routine stack does NOT outnumber what it would leave", () => {
    const calm = groupIllnessTimelineEvents([
      symptom("2026-07-16", "cough"),
      symptom("2026-07-16", "fatigue"),
      temperature("2026-07-16"),
      supplementDose("2026-07-16", 0),
      supplementDose("2026-07-16", 1),
    ]);
    expect(defaultIllnessTimelineFilter(calm)).toBe("all");
  });

  it("never falls back to a single chip — Symptoms alone would hide the medicine", () => {
    // No temperature, so the union chip is not offered. The old fallback narrowed
    // to "Symptoms", which drops every dose row including the ibuprofen. There is
    // no fallback now: the page stays on All and keeps only the legend's win.
    const noTemperature = groupIllnessTimelineEvents([
      symptom("2026-07-16", "cough"),
      medicineDose("2026-07-16", 0),
      ...Array.from({ length: 6 }, (_, index) =>
        supplementDose("2026-07-16", index)
      ),
    ]);
    expect(defaultIllnessTimelineFilter(noTemperature)).toBe("all");
  });

  it("never narrows below the strip's own render threshold — a default the reader cannot undo is a trap", () => {
    // Doses alone: the strip would show "All" plus "Meds", which is under
    // ILLNESS_TIMELINE_MIN_CHIPS, so no chip renders and the default must be All.
    const dosesOnly = groupIllnessTimelineEvents([
      supplementDose("2026-07-16", 0),
      supplementDose("2026-07-16", 1),
    ]);
    expect(availableIllnessTimelineFilters(dosesOnly).length).toBeLessThan(
      ILLNESS_TIMELINE_MIN_CHIPS
    );
    expect(defaultIllnessTimelineFilter(dosesOnly)).toBe("all");
  });
});
