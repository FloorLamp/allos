import { describe, expect, it } from "vitest";
import {
  detectEpisodeTempRedFlag,
  tempRedFlagDedupeKey,
  tempRedFlagFullDetail,
  tempRedFlagTitle,
  tempRedFlagDetail,
  inlineTempRedFlagNote,
  TEMP_RED_FLAG_PREFIX,
} from "@/lib/temp-red-flag";
import { detectTempRedFlag } from "@/lib/datasets/temperature-red-flags";
import { planIllnessCareNudges } from "@/lib/illness-care";
import { fmtTempDual } from "@/lib/units";
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

describe("display units (#1019 — web pref / Telegram dual, identity untouched)", () => {
  const entry = detectTempRedFlag(104.5, null)!; // hyperpyrexia

  it("formatters honor the passed unit; °F stays the default", () => {
    expect(tempRedFlagTitle(entry, 104.5)).toContain("104.5 °F");
    expect(tempRedFlagTitle(entry, 104.5, "C")).toContain("40.3 °C");
    expect(tempRedFlagTitle(entry, 104.5, "C")).not.toContain("104.5 °F");
    expect(tempRedFlagDetail(entry, 104.5, "C")).toContain(
      "A temperature of 40.3 °C was logged"
    );
  });

  it("the Telegram 'dual' display carries BOTH scales", () => {
    expect(fmtTempDual(104.5)).toBe("40.3 °C / 104.5 °F");
    expect(tempRedFlagTitle(entry, 104.5, "dual")).toContain(
      "40.3 °C / 104.5 °F"
    );
    expect(tempRedFlagDetail(entry, 104.5, "dual")).toContain(
      "40.3 °C / 104.5 °F"
    );
  });

  it("cited source lines pass through VERBATIM whatever the display unit", () => {
    // The dataset's own words quote the threshold ("104°F (40°C)") — a °C viewer
    // still reads the source's exact line, never a converted rewrite.
    for (const display of ["F", "C", "dual"] as const) {
      expect(tempRedFlagDetail(entry, 104.5, display)).toContain(entry.line);
      expect(tempRedFlagTitle(entry, 104.5, display)).toContain(entry.label);
    }
    expect(entry.label).toContain("104°F");
  });

  it("dedupeKey is identical across display units (dismiss once, silence everywhere)", () => {
    const findingFor = (display: "F" | "C" | "dual") =>
      detectEpisodeTempRedFlag(
        ep({ temperatures: [tp(104.5)], latestTemp: tp(104.5) }),
        { ageMonths: null, display }
      )!;
    const keys = (["F", "C", "dual"] as const).map(
      (d) => findingFor(d).dedupeKey
    );
    expect(new Set(keys).size).toBe(1);
    // …while the rendered strings DO differ by display.
    expect(findingFor("C").title).not.toBe(findingFor("F").title);
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
    expect(full).not.toMatch(/not medical advice/i);
  });

  it("inline note fires at logging for a crossing reading and is null otherwise", () => {
    expect(inlineTempRedFlagNote(104.1, null)).toMatch(/contact a clinician/i);
    expect(inlineTempRedFlagNote(100.2, 30 * 12)).toBeNull();
    // Infant band needs a known age below the floor.
    expect(inlineTempRedFlagNote(100.6, 2)).toMatch(/contact a clinician/i);
    expect(inlineTempRedFlagNote(100.6, null)).toBeNull();
  });
});

// ---- #1025: the dispatch decision has no day granularity --------------------
//
// The tick used to gate this nudge once per profile-local day, silencing a NEW
// crossing logged after the morning's clean assessment until tomorrow. The gate is
// gone; dedup is owned by the per-finding marker (keyed by the dedupeKey, which
// embeds the READING's date + rule) plus the bus — so these pin that a new
// qualifying reading yields a NEW key that no earlier marker can hold back.

describe("re-nudge on a new crossing (#1025)", () => {
  it("a different reading date (or rule) yields a distinct dedupeKey", () => {
    const a = tempRedFlagDedupeKey(
      "illness",
      "2026-07-10",
      "2026-07-15",
      "hyperpyrexia"
    );
    const b = tempRedFlagDedupeKey(
      "illness",
      "2026-07-10",
      "2026-07-16",
      "hyperpyrexia"
    );
    const c = tempRedFlagDedupeKey(
      "illness",
      "2026-07-10",
      "2026-07-16",
      "infant_fever"
    );
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
  });

  it("a marker for an earlier finding never holds a NEW crossing's key out of the send set", () => {
    // The morning tick assessed clean (no finding, nothing marked) — or fired for
    // yesterday's reading; the 2 PM crossing mints a new key and still sends.
    const yesterdayKey = tempRedFlagDedupeKey(
      "illness",
      "2026-07-10",
      "2026-07-15",
      "hyperpyrexia"
    );
    const newKey = tempRedFlagDedupeKey(
      "illness",
      "2026-07-10",
      "2026-07-16",
      "hyperpyrexia"
    );
    const plan = planIllnessCareNudges([newKey], [yesterdayKey], []);
    expect(plan.toSend).toEqual([newKey]);
    // The stale marker clears (its finding is no longer actionable); the same
    // reading never re-nags once ITS marker is set.
    expect(plan.toClear).toEqual([yesterdayKey]);
    expect(planIllnessCareNudges([newKey], [newKey], []).toSend).toEqual([]);
  });
});
