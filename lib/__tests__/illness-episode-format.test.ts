import { describe, it, expect } from "vitest";
import {
  episodeDayNumber,
  feverTrend,
  feverTrendLabel,
  episodeHeadline,
  householdSickLine,
  isOpenEpisode,
  episodeConditionExternalId,
  type AssembledEpisode,
  type TemperaturePoint,
} from "../illness-episode-format";

// A minimal assembled episode with sensible defaults, overridable per test.
function ep(over: Partial<AssembledEpisode> = {}): AssembledEpisode {
  return {
    id: null,
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
    latestTemp: null,
    medications: [],
    totalAdministrations: 0,
    conditions: [],
    notes: [],
    ...over,
  };
}

function temp(degF: number, flag: string | null = null): TemperaturePoint {
  return { date: "2026-06-02", time: null, degF, flag };
}

describe("episodeDayNumber", () => {
  it("counts the start day as day 1", () => {
    expect(episodeDayNumber("2026-06-01", "2026-06-01")).toBe(1);
    expect(episodeDayNumber("2026-06-01", "2026-06-04")).toBe(4);
  });
  it("is null for an unknown (before-log) start", () => {
    expect(episodeDayNumber(null, "2026-06-04")).toBeNull();
  });
  it("floors at 1 for an as-of before the start", () => {
    expect(episodeDayNumber("2026-06-05", "2026-06-01")).toBe(1);
  });
});

describe("feverTrend", () => {
  it("is null with fewer than two fever-flagged readings", () => {
    expect(feverTrend([])).toBeNull();
    expect(feverTrend([temp(102, "high"), temp(98, null)])).toBeNull();
  });
  it("reads falling when later fevers are cooler", () => {
    expect(
      feverTrend([
        temp(102.4, "high"),
        temp(101.9, "high"),
        temp(100.0, "high"),
        temp(99.2, "high"),
      ])
    ).toBe("falling");
  });
  it("reads rising when later fevers are hotter", () => {
    expect(
      feverTrend([temp(99.5, "high"), temp(100, "high"), temp(102, "high")])
    ).toBe("rising");
  });
  it("reads steady within half a degree", () => {
    expect(
      feverTrend([
        temp(101.0, "high"),
        temp(101.1, "high"),
        temp(101.2, "high"),
      ])
    ).toBe("steady");
  });
  it("ignores non-fever readings when deciding the trend", () => {
    // Only the two 'high' readings count; the normal one is dropped.
    expect(
      feverTrend([temp(98.2, null), temp(103, "high"), temp(100, "high")])
    ).toBe("falling");
  });
});

describe("feverTrendLabel", () => {
  it("maps trends to phrases, null with no curve", () => {
    expect(feverTrendLabel("falling")).toBe("fever trending down");
    expect(feverTrendLabel("rising")).toBe("fever trending up");
    expect(feverTrendLabel("steady")).toBe("fever steady");
    expect(feverTrendLabel(null)).toBeNull();
  });
});

describe("episodeHeadline", () => {
  it("assembles situation · day · fever · symptoms · meds, omitting absent clauses", () => {
    const e = ep({
      distinctSymptomCount: 3,
      temperatures: [
        temp(102.4, "high"),
        temp(101, "high"),
        temp(99.5, "high"),
      ],
      medications: [
        { itemId: 1, name: "Ibuprofen", count: 3, administrations: [] },
      ],
    });
    expect(episodeHeadline(e)).toBe(
      "Illness · day 4 · fever trending down · 3 symptoms · ibuprofen 3×"
    );
  });
  it("degrades to just situation · day for a bare episode", () => {
    expect(episodeHeadline(ep())).toBe("Illness · day 4");
  });
  it("uses singular 'symptom' for a count of one and caps meds at two", () => {
    const e = ep({
      distinctSymptomCount: 1,
      medications: [
        { itemId: 1, name: "Ibuprofen", count: 2, administrations: [] },
        { itemId: 2, name: "Tylenol", count: 1, administrations: [] },
        { itemId: 3, name: "Sudafed", count: 1, administrations: [] },
      ],
    });
    expect(episodeHeadline(e)).toBe(
      "Illness · day 4 · 1 symptom · ibuprofen 2× · tylenol 1×"
    );
  });
});

describe("householdSickLine", () => {
  it("prefixes the name and appends the latest temp", () => {
    const e = ep({ latestTemp: temp(101.3, "high") });
    expect(householdSickLine("Mia", e)).toBe("Mia · sick day 4 · 101.3°F");
  });
  it("drops the day clause when the start is unknown", () => {
    const e = ep({ start: null, latestTemp: null });
    expect(householdSickLine("Mia", e)).toBe("Mia · sick");
  });
});

describe("isOpenEpisode", () => {
  it("is true only for an ongoing episode with at least one signal", () => {
    expect(isOpenEpisode(ep({ ongoing: true, distinctSymptomCount: 2 }))).toBe(
      true
    );
    expect(isOpenEpisode(ep({ ongoing: true }))).toBe(false); // no signal
    expect(isOpenEpisode(ep({ ongoing: false, distinctSymptomCount: 2 }))).toBe(
      false
    ); // closed
  });
});

describe("episodeConditionExternalId", () => {
  it("is deterministic and case/whitespace-insensitive on the situation", () => {
    expect(episodeConditionExternalId("Illness", "2026-06-01")).toBe(
      "episode:illness:2026-06-01"
    );
    expect(episodeConditionExternalId("  ILLNESS ", "2026-06-01")).toBe(
      "episode:illness:2026-06-01"
    );
  });
  it("uses an 'open' sentinel for a null start", () => {
    expect(episodeConditionExternalId("Illness", null)).toBe(
      "episode:illness:open"
    );
  });
});
