import { describe, expect, it } from "vitest";
import {
  detectEpisodeTempRedFlag,
  tempRedFlagDedupeKey,
  tempRedFlagFullDetail,
  inlineTempRedFlagNote,
  TEMP_RED_FLAG_PREFIX,
} from "@/lib/temp-red-flag";
import type {
  AssembledEpisode,
  TemperaturePoint,
} from "@/lib/illness-episode-format";

// Pure tests for the single-reading temperature red-flag engine (issue #859 item 3).
// The dataset detection itself is covered in datasets-temperature-red-flags.test.ts;
// here we pin the episode-level engine (latest reading, dedupeKey, phrasing). No DB.

function ep(over: Partial<AssembledEpisode> = {}): AssembledEpisode {
  return {
    id: 9,
    situation: "Illness",
    start: "2026-06-01",
    end: null,
    ongoing: true,
    firstDay: "2026-06-01",
    lastActiveDay: "2026-06-02",
    asOf: "2026-06-02",
    dayCount: 2,
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

function tp(degF: number): TemperaturePoint {
  return { date: "2026-06-02", time: "09:00", degF, flag: "high" };
}

describe("detectEpisodeTempRedFlag", () => {
  it("flags a young infant's fever on the latest reading", () => {
    const f = detectEpisodeTempRedFlag(
      ep({ temperatures: [tp(100.8)], latestTemp: tp(100.8) }),
      { ageMonths: 2 }
    );
    expect(f?.ruleKey).toBe("infant_fever");
    expect(f?.degF).toBe(100.8);
    expect(f?.dedupeKey.startsWith(TEMP_RED_FLAG_PREFIX)).toBe(true);
    expect(f?.title).toContain("100.8");
    expect(f?.detail).toMatch(/contact a clinician/i);
  });

  it("flags a very high fever at any age", () => {
    const f = detectEpisodeTempRedFlag(
      ep({ temperatures: [tp(104.3)], latestTemp: tp(104.3) }),
      { ageMonths: 30 * 12 }
    );
    expect(f?.ruleKey).toBe("hyperpyrexia");
  });

  it("returns null when the latest reading crosses nothing", () => {
    expect(
      detectEpisodeTempRedFlag(
        ep({ temperatures: [tp(100.9)], latestTemp: tp(100.9) }),
        { ageMonths: 30 * 12 }
      )
    ).toBeNull();
  });

  it("returns null when there is no temperature reading", () => {
    expect(detectEpisodeTempRedFlag(ep(), { ageMonths: 2 })).toBeNull();
  });

  it("dedupeKey is episode + reading anchored", () => {
    const key = tempRedFlagDedupeKey(
      "Illness",
      "2026-06-01",
      "2026-06-02",
      "infant_fever"
    );
    expect(key).toBe(
      "temp-red-flag:illness:2026-06-01:2026-06-02:infant_fever"
    );
  });
});

describe("tempRedFlagFullDetail / inlineTempRedFlagNote", () => {
  it("full detail carries the source + the disclaimer tail", () => {
    const f = detectEpisodeTempRedFlag(
      ep({ temperatures: [tp(104.5)], latestTemp: tp(104.5) }),
      { ageMonths: null }
    )!;
    const full = tempRedFlagFullDetail(f);
    expect(full).toMatch(/Source:/);
    expect(full).toMatch(/not medical advice/i);
  });

  it("inline note fires at logging for a crossing reading and is null otherwise", () => {
    expect(inlineTempRedFlagNote(104.1, null)).toMatch(/contact a clinician/i);
    expect(inlineTempRedFlagNote(100.2, 30 * 12)).toBeNull();
    // Infant band needs a known age below the floor.
    expect(inlineTempRedFlagNote(100.6, 2)).toMatch(/contact a clinician/i);
    expect(inlineTempRedFlagNote(100.6, null)).toBeNull();
  });
});
