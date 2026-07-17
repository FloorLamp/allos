import { describe, expect, it } from "vitest";
import { emergencyEpisodeSection } from "@/lib/illness-episode-format";
import { buildEmergencyCard, isEmergencyCardEmpty } from "@/lib/emergency-card";
import type { AssembledEpisode } from "@/lib/illness-episode-format";

// Pure tests for the Emergency Card active-episode section (issue #859 item 6). No DB.

function ep(over: Partial<AssembledEpisode> = {}): AssembledEpisode {
  return {
    id: 3,
    situation: "Illness",
    start: "2026-06-01",
    end: null,
    ongoing: true,
    firstDay: "2026-06-01",
    lastActiveDay: "2026-06-04",
    asOf: "2026-06-04",
    dayCount: 4,
    symptoms: [],
    distinctSymptomCount: 0,
    temperatures: [],
    maxTempF: null,
    latestTemp: { date: "2026-06-04", time: "14:00", degF: 101.3, flag: "high" },
    medications: [
      {
        itemId: 1,
        name: "Ibuprofen",
        count: 2,
        administrations: [
          { date: "2026-06-03", time: "9:00pm", amount: "200 mg" },
          { date: "2026-06-04", time: "8:00am", amount: "200 mg" },
        ],
      },
    ],
    totalAdministrations: 2,
    conditions: [],
    notes: [],
    ...over,
  };
}

describe("emergencyEpisodeSection", () => {
  it("summarizes an open episode with day, today's meds, and latest temp", () => {
    const sec = emergencyEpisodeSection(ep(), "F");
    expect(sec).not.toBeNull();
    expect(sec!.headline).toBe("Illness · day 4");
    expect(sec!.dayNumber).toBe(4);
    expect(sec!.latestTemp).toBe("101.3 °F");
    // ONLY today's (asOf 2026-06-04) administrations.
    expect(sec!.todaysAdministrations).toHaveLength(1);
    expect(sec!.todaysAdministrations[0]).toMatchObject({
      name: "Ibuprofen",
      time: "8:00am",
      amount: "200 mg",
    });
  });

  it("renders the temperature in the viewer's unit", () => {
    expect(emergencyEpisodeSection(ep(), "C")!.latestTemp).toContain("°C");
  });

  it("returns null for a CLOSED episode (renders nothing)", () => {
    expect(
      emergencyEpisodeSection(ep({ ongoing: false, end: "2026-06-05" }), "F")
    ).toBeNull();
  });
});

describe("emergency card integration", () => {
  const baseInput = {
    name: "Test Patient",
    age: 4,
    sex: null,
    birthdate: null,
    manualBloodType: null,
    derivedBloodType: null,
    allergies: [],
    medications: [],
    conditions: [],
    contact: null,
    generatedAt: "2026-06-04T12:00:00.000Z",
  };

  it("an active episode makes an otherwise-empty card non-empty", () => {
    const withEpisode = buildEmergencyCard({
      ...baseInput,
      activeEpisode: emergencyEpisodeSection(ep(), "F"),
    });
    expect(withEpisode.activeEpisode).not.toBeNull();
    expect(isEmergencyCardEmpty(withEpisode)).toBe(false);
  });

  it("no episode leaves the field null and the card empty", () => {
    const card = buildEmergencyCard(baseInput);
    expect(card.activeEpisode ?? null).toBeNull();
    expect(isEmergencyCardEmpty(card)).toBe(true);
  });
});
