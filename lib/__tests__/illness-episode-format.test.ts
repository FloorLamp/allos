import { describe, it, expect } from "vitest";
import {
  episodeDayNumber,
  feverTrend,
  feverTrendLabel,
  episodeHeadline,
  householdSickLine,
  episodeLastDoseClause,
  orderIllnessCockpits,
  isOpenEpisode,
  episodeConditionExternalId,
  type AssembledEpisode,
  type EpisodeMedication,
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

// A PRN med with administration points (date/time/amount), for the last-dose clause.
function med(
  name: string,
  admins: { date: string; time: string | null }[]
): EpisodeMedication {
  return {
    itemId: 1,
    name,
    count: admins.length,
    administrations: admins.map((a) => ({ ...a, amount: null })),
  };
}

describe("episodeLastDoseClause", () => {
  it("is null when nothing was administered", () => {
    expect(episodeLastDoseClause(ep())).toBeNull();
  });
  it("formats the most-recent administration, lowercasing the med name", () => {
    const e = ep({
      medications: [
        med("Ibuprofen", [
          { date: "2026-06-02", time: "2:00pm" },
          { date: "2026-06-03", time: "4:02pm" },
        ]),
      ],
    });
    expect(episodeLastDoseClause(e)).toBe("last ibuprofen 4:02pm");
  });
  it("picks the globally latest administration across meds", () => {
    const e = ep({
      medications: [
        med("Ibuprofen", [{ date: "2026-06-03", time: "1:00pm" }]),
        med("Tylenol", [{ date: "2026-06-03", time: "6:30pm" }]),
      ],
    });
    expect(episodeLastDoseClause(e)).toBe("last tylenol 6:30pm");
  });
  it("degrades to just the name when the clock is unknown", () => {
    const e = ep({
      medications: [med("Ibuprofen", [{ date: "2026-06-03", time: null }])],
    });
    expect(episodeLastDoseClause(e)).toBe("last ibuprofen");
  });
});

describe("householdSickLine", () => {
  it("prefixes the name and appends the latest temp", () => {
    const e = ep({ latestTemp: temp(101.3, "high") });
    expect(householdSickLine("Mia", e)).toBe("Mia · sick day 4 · 101.3 °F");
  });
  it("drops the day clause when the start is unknown", () => {
    const e = ep({ start: null, latestTemp: null });
    expect(householdSickLine("Mia", e)).toBe("Mia · sick");
  });
  it("appends the last-dose clause (the co-caregiver double-dose guard, #858)", () => {
    const e = ep({
      latestTemp: temp(101.3, "high"),
      medications: [med("Ibuprofen", [{ date: "2026-06-03", time: "4:02pm" }])],
    });
    expect(householdSickLine("Mia", e)).toBe(
      "Mia · sick day 4 · 101.3 °F · last ibuprofen 4:02pm"
    );
  });
});

describe("orderIllnessCockpits", () => {
  it("puts the acting profile's cockpit first regardless of its start", () => {
    const ordered = orderIllnessCockpits([
      { profileId: 2, isActive: false, start: "2026-06-01" },
      { profileId: 1, isActive: true, start: "2026-06-05" },
    ]);
    expect(ordered.map((c) => c.profileId)).toEqual([1, 2]);
  });
  it("orders other profiles by episode start (earliest first), then profileId", () => {
    const ordered = orderIllnessCockpits([
      { profileId: 5, isActive: false, start: "2026-06-03" },
      { profileId: 3, isActive: false, start: "2026-06-01" },
      { profileId: 4, isActive: false, start: "2026-06-01" },
    ]);
    expect(ordered.map((c) => c.profileId)).toEqual([3, 4, 5]);
  });
  it("sorts a null (before-log) start after known starts", () => {
    const ordered = orderIllnessCockpits([
      { profileId: 7, isActive: false, start: null },
      { profileId: 6, isActive: false, start: "2026-06-02" },
    ]);
    expect(ordered.map((c) => c.profileId)).toEqual([6, 7]);
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
