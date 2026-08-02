// PURE TIER — the audiogram domain (issue #1600): the canonical per-ear/per-frequency
// identity, the reading → dated-audiogram grouping, the latest-per-group current
// thresholds, the ASHA threshold-shift criteria, and the baseline sentence the ototoxic
// note cites. No DB, no network.

import { describe, it, expect } from "vitest";
import {
  AUDIOGRAM_CANONICAL_NAMES,
  audiogramAnalyteName,
  audiogramFieldName,
  audiogramSeriesKey,
  currentThresholds,
  detectThresholdShift,
  frequencyLabel,
  groupAudiogramReadings,
  hearingBaselineFromReadings,
  hearingBaselineSentence,
  hearingGrade,
  parseAudiogramAnalyte,
  pureToneAverage,
  thresholdShiftLabel,
  type AudiogramEar,
  type AudiogramFrequencyHz,
  type AudiogramPoint,
  type AudiogramReading,
} from "@/lib/audiogram";
import canonical from "@/lib/canonical-biomarkers.json";

let nextId = 1;
function reading(
  date: string,
  ear: AudiogramEar,
  hz: AudiogramFrequencyHz,
  dbHl: number
): AudiogramReading {
  return { id: nextId++, date, ear, hz, dbHl, notes: null, flag: null };
}
function point(
  ear: AudiogramEar,
  hz: AudiogramFrequencyHz,
  dbHl: number
): AudiogramPoint {
  return { ear, hz, dbHl };
}

describe("audiogram vocabulary (#1600)", () => {
  it("produces the analyte names the canonical dataset already curates", () => {
    // The store decision made concrete: every name this domain writes must ALREADY
    // exist in lib/canonical-biomarkers.json, or a manually entered threshold would
    // land outside the reference band and never flag. This is the pin that keeps the
    // reuse honest — if the two ever drift, the entry surface stops flagging.
    const curated = new Set(
      (canonical as { biomarkers: { name: string }[] }).biomarkers.map(
        (b) => b.name
      )
    );
    expect(AUDIOGRAM_CANONICAL_NAMES).toHaveLength(12);
    for (const name of AUDIOGRAM_CANONICAL_NAMES) {
      expect(curated.has(name), `${name} missing from the canonical set`).toBe(
        true
      );
    }
  });

  it("spells frequencies the way the canonical names do", () => {
    expect(frequencyLabel(250)).toBe("250 Hz");
    expect(frequencyLabel(1000)).toBe("1 kHz");
    expect(frequencyLabel(8000)).toBe("8 kHz");
    expect(audiogramAnalyteName("right", 4000)).toBe(
      "Hearing Threshold, Right Ear 4 kHz"
    );
    expect(audiogramAnalyteName("left", 500)).toBe(
      "Hearing Threshold, Left Ear 500 Hz"
    );
  });

  it("round-trips a canonical name back to its (ear, frequency) identity", () => {
    for (const name of AUDIOGRAM_CANONICAL_NAMES) {
      const parsed = parseAudiogramAnalyte(name);
      expect(parsed).not.toBeNull();
      expect(audiogramAnalyteName(parsed!.ear, parsed!.hz)).toBe(name);
    }
    // Tolerant of a non-canonical "1000 Hz" spelling a future importer may hand it…
    expect(
      parseAudiogramAnalyte("Hearing Threshold, Left Ear 1000 Hz")
    ).toEqual({ ear: "left", hz: 1000 });
    // …but never claims a non-audiogram analyte, an unsupported frequency, or a
    // threshold with no laterality.
    expect(parseAudiogramAnalyte("Intraocular Pressure, Right Eye")).toBeNull();
    expect(
      parseAudiogramAnalyte("Hearing Threshold, Right Ear 3 kHz")
    ).toBeNull();
    expect(parseAudiogramAnalyte("Hearing Threshold 4 kHz")).toBeNull();
    expect(parseAudiogramAnalyte(null)).toBeNull();
  });

  it("keys each ear/frequency as its own series (the #713 singleton identity)", () => {
    // Two ears at one frequency, and two frequencies in one ear, are DIFFERENT
    // subjects — never one group. Collapsing them would let a normal reading mark a
    // flagged one 'current'.
    expect(audiogramSeriesKey("right", 4000)).not.toBe(
      audiogramSeriesKey("left", 4000)
    );
    expect(audiogramSeriesKey("right", 4000)).not.toBe(
      audiogramSeriesKey("right", 8000)
    );
    expect(audiogramFieldName("right", 4000)).toBe("right_4000");
  });
});

describe("grouping and current thresholds", () => {
  it("groups readings into dated audiograms, newest first", () => {
    const rows = [
      reading("2026-01-10", "right", 1000, 10),
      reading("2026-01-10", "left", 1000, 15),
      reading("2024-02-02", "right", 1000, 5),
    ];
    const grouped = groupAudiogramReadings(rows);
    expect(grouped.map((a) => a.date)).toEqual(["2026-01-10", "2024-02-02"]);
    expect(grouped[0].readings).toHaveLength(2);
    // Right ear before left within an audiogram, so the rendered grid is stable.
    expect(grouped[0].readings[0].ear).toBe("right");
  });

  it("current thresholds come from latestByGroup, so a PARTIAL retest only refreshes what it measured", () => {
    const rows = [
      reading("2024-01-01", "right", 1000, 10),
      reading("2024-01-01", "right", 4000, 20),
      // A later visit re-tested 4 kHz only.
      reading("2026-01-01", "right", 4000, 45),
    ];
    const current = currentThresholds(rows);
    expect(current.get(audiogramSeriesKey("right", 4000))!.dbHl).toBe(45);
    // The 1 kHz series is untouched and still current at its own last value — not
    // dropped because a newer DATE exists.
    expect(current.get(audiogramSeriesKey("right", 1000))!.dbHl).toBe(10);
  });

  it("breaks a same-date tie on the higher id, like the shared latest rule", () => {
    const older = reading("2026-03-01", "left", 2000, 30);
    const corrected = reading("2026-03-01", "left", 2000, 20);
    const current = currentThresholds([older, corrected]);
    expect(current.get(audiogramSeriesKey("left", 2000))!.dbHl).toBe(20);
  });
});

describe("pure-tone average and grade", () => {
  it("averages the PTA frequencies present, rounded to whole decibels", () => {
    const points = [
      point("right", 500, 10),
      point("right", 1000, 15),
      point("right", 2000, 20),
      point("right", 4000, 40),
      point("right", 8000, 60), // outside the PTA set — must not pull the average
    ];
    const pta = pureToneAverage(points, "right");
    expect(pta).toEqual({
      ear: "right",
      dbHl: 21,
      usedHz: [500, 1000, 2000, 4000],
    });
    // No readings for the other ear ⇒ no average invented.
    expect(pureToneAverage(points, "left")).toBeNull();
  });

  it("grades on the band whose normal boundary matches the curated ref_high", () => {
    expect(hearingGrade(25)).toBe("normal");
    expect(hearingGrade(26)).toBe("mild");
    expect(hearingGrade(41)).toBe("moderate");
    expect(hearingGrade(95)).toBe("profound");
  });
});

describe("threshold shift — the ASHA ototoxicity criteria (#1600)", () => {
  it("fires on a 20 dB worsening at a single frequency", () => {
    const shifts = detectThresholdShift(
      [point("right", 4000, 20)],
      [point("right", 4000, 40)]
    );
    expect(shifts).toHaveLength(1);
    expect(shifts[0]).toMatchObject({
      ear: "right",
      criterion: "single-20db",
      frequenciesHz: [4000],
      worstDeltaDb: 20,
    });
    expect(thresholdShiftLabel(shifts[0])).toBe("20 dB at 4 kHz, right ear");
  });

  it("fires on a 10 dB worsening at two ADJACENT frequencies", () => {
    const shifts = detectThresholdShift(
      [point("left", 4000, 25), point("left", 8000, 30)],
      [point("left", 4000, 40), point("left", 8000, 45)]
    );
    expect(shifts).toHaveLength(1);
    expect(shifts[0]).toMatchObject({
      criterion: "adjacent-10db",
      frequenciesHz: [4000, 8000],
      worstDeltaDb: 15,
    });
    expect(thresholdShiftLabel(shifts[0])).toBe(
      "15 dB across 4 kHz and 8 kHz, left ear"
    );
  });

  it("does NOT fire on two NON-adjacent 10 dB moves, or on improvement, or on noise", () => {
    // 1 kHz and 4 kHz are not adjacent on the test ladder (2 kHz sits between them).
    expect(
      detectThresholdShift(
        [point("right", 1000, 10), point("right", 4000, 20)],
        [point("right", 1000, 22), point("right", 4000, 32)]
      )
    ).toEqual([]);
    // Hearing that got BETTER is not a shift.
    expect(
      detectThresholdShift(
        [point("right", 4000, 40)],
        [point("right", 4000, 15)]
      )
    ).toEqual([]);
    // A 5 dB wobble is within test-retest noise.
    expect(
      detectThresholdShift(
        [point("right", 4000, 20), point("right", 8000, 20)],
        [point("right", 4000, 25), point("right", 8000, 25)]
      )
    ).toEqual([]);
  });

  it("compares only frequencies measured on BOTH dates, and reports per ear", () => {
    const shifts = detectThresholdShift(
      [point("right", 4000, 20), point("left", 4000, 20)],
      [
        point("right", 4000, 45),
        point("left", 4000, 45),
        point("left", 8000, 90), // no baseline for this one — nothing to compare
      ]
    );
    expect(shifts.map((s) => s.ear)).toEqual(["right", "left"]);
    expect(shifts[1].frequenciesHz).toEqual([4000]);
  });
});

describe("the hearing baseline the ototoxic note cites", () => {
  it("is null with no readings at all — the note must not nag for a test never had", () => {
    expect(hearingBaselineFromReadings([])).toBeNull();
  });

  it("cites the newest audiogram and no shift when there is only one on file", () => {
    const b = hearingBaselineFromReadings([
      reading("2026-04-01", "right", 4000, 30),
      reading("2026-04-01", "left", 4000, 20),
    ])!;
    expect(b.latestDate).toBe("2026-04-01");
    expect(b.baselineDate).toBeNull();
    expect(b.shifts).toEqual([]);
    expect(b.worst).toEqual({ ear: "right", hz: 4000, dbHl: 30 });
    expect(hearingBaselineSentence(b)).toBe(
      "Hearing baseline on file: audiogram 2026-04-01 (worst current threshold 30 dB HL at 4 kHz, right ear)."
    );
  });

  it("names the documented shift when a later audiogram meets the criteria", () => {
    const b = hearingBaselineFromReadings([
      reading("2024-01-01", "right", 4000, 25),
      reading("2024-01-01", "right", 8000, 30),
      reading("2026-06-01", "right", 4000, 40),
      reading("2026-06-01", "right", 8000, 45),
    ])!;
    expect(b.baselineDate).toBe("2024-01-01");
    expect(b.latestDate).toBe("2026-06-01");
    const sentence = hearingBaselineSentence(b);
    expect(sentence).toContain("documented threshold shift since 2024-01-01");
    expect(sentence).toContain("15 dB across 4 kHz and 8 kHz, right ear");
    expect(sentence).toContain("ASHA ototoxicity-monitoring criteria");
  });
});
