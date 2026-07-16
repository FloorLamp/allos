import { describe, it, expect } from "vitest";
import {
  episodeContainingDate,
  episodeForDate,
  episodesForSituation,
} from "@/lib/symptom-episode";
import {
  situationsActiveOn,
  type SituationEvent,
} from "@/lib/trend-annotations";

// Pure tests for the DERIVED illness-episode association (#799): the shared computation the
// dashboard card and the future episode view (#800) both key on. Also pins the "keys ONLY
// on flagged situations" rule (the caller passes only illness-type rows) and consistency
// with the #654 situationsActiveOn reconstruction.

const ev = (
  situation: string,
  date: string,
  change: "start" | "stop"
): SituationEvent => ({ situation, date, change });

describe("episodeContainingDate", () => {
  const closed = [
    ev("Illness", "2026-01-01", "start"),
    ev("Illness", "2026-01-10", "stop"),
  ];

  it("returns [start, end) for a mid-episode date; start day inclusive, stop day exclusive", () => {
    expect(
      episodeContainingDate("2026-01-05", "Illness", closed, false)
    ).toEqual({
      situation: "Illness",
      start: "2026-01-01",
      end: "2026-01-10",
    });
    // The start day is inside the episode.
    expect(
      episodeContainingDate("2026-01-01", "Illness", closed, false)
    ).toEqual({
      situation: "Illness",
      start: "2026-01-01",
      end: "2026-01-10",
    });
    // The stop day is the first inactive day → no episode.
    expect(
      episodeContainingDate("2026-01-10", "Illness", closed, false)
    ).toBeNull();
    // Before the start → no episode.
    expect(
      episodeContainingDate("2025-12-31", "Illness", closed, false)
    ).toBeNull();
  });

  it("an ongoing situation (currently active, no stop) has a null end", () => {
    const open = [ev("Illness", "2026-03-01", "start")];
    expect(episodeContainingDate("2026-03-09", "Illness", open, true)).toEqual({
      situation: "Illness",
      start: "2026-03-01",
      end: null,
    });
    // Day before the start is inactive.
    expect(
      episodeContainingDate("2026-02-28", "Illness", open, true)
    ).toBeNull();
  });

  it("active since before the (capped) log has a null start", () => {
    expect(episodeContainingDate("2026-05-01", "Illness", [], true)).toEqual({
      situation: "Illness",
      start: null,
      end: null,
    });
    // Not active, no events → null.
    expect(
      episodeContainingDate("2026-05-01", "Illness", [], false)
    ).toBeNull();
  });

  it("agrees with situationsActiveOn (#654) on every membership decision", () => {
    const events = [
      ev("Illness", "2026-01-01", "start"),
      ev("Illness", "2026-01-10", "stop"),
      ev("Illness", "2026-02-01", "start"),
    ];
    const current = ["Illness"]; // reactivated on 2026-02-01, still on
    for (const d of [
      "2025-12-31",
      "2026-01-01",
      "2026-01-05",
      "2026-01-10",
      "2026-01-20",
      "2026-02-01",
      "2026-03-01",
    ]) {
      const active = situationsActiveOn(d, current, events).has("Illness");
      const ep = episodeContainingDate(d, "Illness", events, true);
      expect(ep !== null, d).toBe(active);
    }
  });
});

describe("episodesForSituation (enumeration for #800)", () => {
  it("pairs consecutive start→stop, leaves an unclosed start ongoing", () => {
    const events = [
      ev("Illness", "2026-01-01", "start"),
      ev("Illness", "2026-01-10", "stop"),
      ev("Illness", "2026-02-01", "start"),
    ];
    expect(episodesForSituation("Illness", events, true)).toEqual([
      { situation: "Illness", start: "2026-01-01", end: "2026-01-10" },
      { situation: "Illness", start: "2026-02-01", end: null },
    ]);
  });

  it("a leading stop is a before-log episode (null start)", () => {
    const events = [ev("Illness", "2026-01-10", "stop")];
    expect(episodesForSituation("Illness", events, false)).toEqual([
      { situation: "Illness", start: null, end: "2026-01-10" },
    ]);
  });

  it("currently active with no events → one ongoing before-log episode", () => {
    expect(episodesForSituation("Illness", [], true)).toEqual([
      { situation: "Illness", start: null, end: null },
    ]);
  });
});

describe("episodeForDate — keys only on the passed (flagged) situations", () => {
  const events = [
    ev("Illness", "2026-01-01", "start"),
    ev("Migraine", "2026-01-04", "start"),
  ];

  it("returns null when no flagged situation is passed, even if events match", () => {
    expect(episodeForDate("2026-01-05", [], events)).toBeNull();
  });

  it("associates the date with the most-recently-started containing episode", () => {
    const ep = episodeForDate(
      "2026-01-05",
      [
        { name: "Illness", active: true },
        { name: "Migraine", active: true },
      ],
      events
    );
    // Migraine started later (2026-01-04) → the tighter containing episode wins.
    expect(ep?.situation).toBe("Migraine");
    expect(ep?.start).toBe("2026-01-04");
  });

  it("returns null when the flagged situation was not active on the date", () => {
    const closed = [
      ev("Illness", "2026-01-01", "start"),
      ev("Illness", "2026-01-03", "stop"),
    ];
    expect(
      episodeForDate("2026-01-05", [{ name: "Illness", active: false }], closed)
    ).toBeNull();
  });
});
