import { describe, it, expect } from "vitest";
import {
  sleepDurationLabel,
  sleepFactSummary,
  sleepNightLabel,
  typicalSleepMinutes,
  type SleepFactInput,
} from "../sleep-facts";
import type { SleepMoodHistoryRow } from "../sleep-summary";

// #3222: the manual sleep entry states three facts. What is pinned here is which facts
// the row states and in what STATE — not the wording, which is copy.

function night(
  date: string,
  overrides: Partial<SleepMoodHistoryRow> = {}
): SleepMoodHistoryRow {
  return {
    date,
    sleepHours: null,
    valence: null,
    moodDetails: null,
    stages: null,
    bedtimeSupplements: null,
    sleepEditable: true,
    sleepEditHours: null,
    sleepSampleId: null,
    moodLogId: null,
    sleepSuspect: false,
    sleepSettledMinutes: null,
    ...overrides,
  };
}

const BASE: SleepFactInput = {
  nightLabel: "Last night",
  durationMinutes: null,
  durationEditable: true,
  importedMinutes: null,
  durationSuggested: false,
  valence: null,
};

function states(input: Partial<SleepFactInput>) {
  return sleepFactSummary({ ...BASE, ...input }).chips.map((chip) => [
    chip.key,
    chip.state,
  ]);
}

describe("the sleep entry's duration label", () => {
  it("drops the empty half of an hours-and-minutes duration", () => {
    expect(sleepDurationLabel(460)).toBe("7 h 40 m");
    expect(sleepDurationLabel(420)).toBe("7 h");
    expect(sleepDurationLabel(40)).toBe("40 m");
  });
});

describe("the night chip's sentence", () => {
  it("names the two recent nights relatively and dates the rest", () => {
    // A sleep row is dated by the day the person WOKE, so today's entry is the night
    // that just ended.
    expect(sleepNightLabel("2026-08-20", "2026-08-20")).toBe("Last night");
    expect(sleepNightLabel("2026-08-19", "2026-08-20")).toBe(
      "The night before"
    );
    expect(sleepNightLabel("2026-08-11", "2026-08-20")).not.toMatch(/night/i);
  });
});

describe("the typical duration a blank night borrows from", () => {
  it("takes the median of recent MANUAL nights, rounded to five minutes", () => {
    const history = [
      night("2026-08-16", { sleepEditHours: 6 }),
      night("2026-08-17", { sleepEditHours: 7 }),
      // 7 h 26 m — the median, and the reason the result is rounded: a suggestion
      // claiming a minute-exact number is claiming a precision it does not have.
      night("2026-08-18", { sleepEditHours: 446 / 60 }),
      night("2026-08-19", { sleepEditHours: 8 }),
      night("2026-08-20", { sleepEditHours: 9 }),
    ];
    expect(typicalSleepMinutes(history)).toBe(445);
  });

  it("ignores imported nights, which are a different instrument", () => {
    // A synced total is not the kind of number this dialog writes, so borrowing one
    // would suggest a value the person could not have produced here.
    const history = [
      night("2026-08-19", { sleepHours: 5, sleepEditable: false }),
      night("2026-08-20", { sleepHours: 5.5, sleepEditable: false }),
    ];
    expect(typicalSleepMinutes(history)).toBeNull();
  });

  it("reads only the most recent window, so an old habit stops voting", () => {
    const old = Array.from({ length: 14 }, (_, i) =>
      night(`2026-07-${String(i + 1).padStart(2, "0")}`, { sleepEditHours: 5 })
    );
    const recent = Array.from({ length: 14 }, (_, i) =>
      night(`2026-08-${String(i + 1).padStart(2, "0")}`, { sleepEditHours: 8 })
    );
    expect(typicalSleepMinutes([...old, ...recent])).toBe(480);
  });

  it("has nothing to say for a profile with no manual nights", () => {
    expect(typicalSleepMinutes([])).toBeNull();
  });
});

describe("which facts the sleep row states (#3222)", () => {
  it("prompts for the two facts the dialog exists to write when both are empty", () => {
    expect(states({})).toEqual([
      ["night", "stated"],
      ["duration", "missing"],
      ["mood", "missing"],
    ]);
  });

  it("states a duration and a mood once each is answered", () => {
    expect(states({ durationMinutes: 460, valence: 4 })).toEqual([
      ["night", "stated"],
      ["duration", "stated"],
      ["mood", "stated"],
    ]);
  });

  it("carries the suggestion marking onto the duration chip, and nowhere else", () => {
    const chips = sleepFactSummary({
      ...BASE,
      durationMinutes: 445,
      durationSuggested: true,
      valence: 4,
    }).chips;
    expect(chips.find((c) => c.key === "duration")?.suggested).toBe(true);
    // The marking is the whole difference between prefilling and asserting, so a fact
    // the person did state must not carry it.
    expect(chips.find((c) => c.key === "mood")?.suggested).toBeFalsy();
  });

  it("drops the night chip when the date is not editable", () => {
    // An edit opens one existing row; its date is stated by the dialog title, and a
    // disclosure that opens onto nothing is worse than no disclosure.
    expect(states({ nightLabel: null }).map(([key]) => key)).toEqual([
      "duration",
      "mood",
    ]);
  });

  it("states a synced night's measured duration rather than hiding it behind the editor", () => {
    const chips = sleepFactSummary({
      ...BASE,
      durationEditable: false,
      importedMinutes: 461,
    }).chips;
    const duration = chips.find((c) => c.key === "duration");
    expect(duration?.state).toBe("stated");
    expect(duration?.label).toContain("7 h 41 m");
  });
});
