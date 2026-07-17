import { describe, expect, it } from "vitest";
import { computeStaleEpisode } from "@/lib/stale-episode";
import type {
  AssembledEpisode,
  SymptomSeries,
  TemperaturePoint,
} from "@/lib/illness-episode-format";

// Pure tests for the stale-open-episode detection (issue #859 item 1). No DB/network.

function ep(over: Partial<AssembledEpisode> = {}): AssembledEpisode {
  return {
    id: 5,
    situation: "Illness",
    start: "2026-06-01",
    end: null,
    ongoing: true,
    firstDay: "2026-06-01",
    lastActiveDay: "2026-06-10",
    asOf: "2026-06-10",
    dayCount: 10,
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

function symptom(date: string): SymptomSeries {
  return {
    symptom: "cough",
    label: "Cough",
    points: [{ date, severity: 2, note: null }],
    maxSeverity: 2,
  };
}

function temp(date: string): TemperaturePoint {
  return { date, time: null, degF: 100.4, flag: "high" };
}

describe("computeStaleEpisode", () => {
  it("flags a quiet open episode past the threshold", () => {
    // Last symptom logged 2026-06-05, asOf 2026-06-10 → 5 quiet days.
    const s = computeStaleEpisode(
      ep({ symptoms: [symptom("2026-06-05")], distinctSymptomCount: 1 }),
      3
    );
    expect(s.lastActivityDate).toBe("2026-06-05");
    expect(s.quietDays).toBe(5);
    expect(s.isStale).toBe(true);
  });

  it("does NOT flag an actively-logged open episode", () => {
    const s = computeStaleEpisode(
      ep({
        symptoms: [symptom("2026-06-09")],
        temperatures: [temp("2026-06-10")],
        distinctSymptomCount: 1,
      }),
      3
    );
    // Latest signal is a temperature today.
    expect(s.lastActivityDate).toBe("2026-06-10");
    expect(s.quietDays).toBe(0);
    expect(s.isStale).toBe(false);
  });

  it("uses the latest signal across symptoms/temps/meds", () => {
    const s = computeStaleEpisode(
      ep({
        symptoms: [symptom("2026-06-04")],
        medications: [
          {
            itemId: 1,
            name: "Ibuprofen",
            count: 1,
            administrations: [
              { date: "2026-06-06", time: "6:00am", amount: "200 mg" },
            ],
          },
        ],
        totalAdministrations: 1,
      }),
      3
    );
    expect(s.lastActivityDate).toBe("2026-06-06");
    expect(s.quietDays).toBe(4);
    expect(s.isStale).toBe(true);
  });

  it("falls back to the episode start when nothing was ever logged", () => {
    const s = computeStaleEpisode(ep(), 3);
    expect(s.lastActivityDate).toBe("2026-06-01");
    expect(s.quietDays).toBe(9);
    expect(s.isStale).toBe(true);
  });

  it("is never stale for a CLOSED episode", () => {
    const s = computeStaleEpisode(
      ep({
        ongoing: false,
        end: "2026-06-06",
        symptoms: [symptom("2026-06-01")],
      }),
      3
    );
    expect(s.isStale).toBe(false);
  });

  it("respects a custom threshold", () => {
    const base = ep({
      symptoms: [symptom("2026-06-08")],
      distinctSymptomCount: 1,
    });
    // 2 quiet days: stale at threshold 2, not at 3.
    expect(computeStaleEpisode(base, 2).isStale).toBe(true);
    expect(computeStaleEpisode(base, 3).isStale).toBe(false);
  });
});
