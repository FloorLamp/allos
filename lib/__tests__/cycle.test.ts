import { describe, it, expect } from "vitest";
import {
  cyclePhaseOnDate,
  cycleDayOnDate,
  cycleLengths,
  cycleStats,
  periodLengthDays,
  periodOnDate,
  isFlowLevel,
  isStaleOpenPeriod,
  LUTEAL_PHASE_DAYS,
  MAX_PLAUSIBLE_PERIOD_DAYS,
  type CyclePeriod,
} from "@/lib/cycle";

// Pure-tier: the cycle-phase / length / variability derivations (issue #714). No DB.
// The phase computation is the ONE function every surface formats over (Cycle card,
// Timeline chip, the #718 phase-specific reference-range feed), so its edges are pinned
// here. Deliberately NON-predictive: luteal is only assigned retrospectively.

// A 28-day-ish history: periods starting on the 1st of each month, each a 5-day period
// (inclusive end on the 5th). ids ascending with dates.
function period(
  id: number,
  start: string,
  end: string | null,
  flow: CyclePeriod["flow"] = null
): CyclePeriod {
  return { id, period_start: start, period_end: end, flow, note: null };
}

const HISTORY: CyclePeriod[] = [
  period(1, "2026-01-01", "2026-01-05"),
  period(2, "2026-01-29", "2026-02-02"), // 28-day cycle
  period(3, "2026-02-26", "2026-03-02"), // 28-day cycle
];

// Every RETROSPECTIVE assertion below asks about a day the profile has already lived
// through, so they share one horizon past all of them. The #2613 future-refusal cases
// state their own `today` explicitly — that argument is the whole subject there.
const LIVED_THROUGH = "2027-01-01";
const phaseOn = (
  periods: CyclePeriod[],
  date: string,
  today: string = LIVED_THROUGH
) => cyclePhaseOnDate(periods, date, today);

describe("cycleDayOnDate (#1221)", () => {
  it("returns null before any recorded period", () => {
    expect(cycleDayOnDate(HISTORY, "2025-12-31")).toBeNull();
  });

  it("counts 1-based from the current cycle's start (start day = day 1)", () => {
    expect(cycleDayOnDate(HISTORY, "2026-01-01")).toBe(1);
    expect(cycleDayOnDate(HISTORY, "2026-01-05")).toBe(5);
    // Day before the next period start (2026-01-29) is cycle day 28.
    expect(cycleDayOnDate(HISTORY, "2026-01-28")).toBe(28);
  });

  it("resets to day 1 at the next recorded period start", () => {
    expect(cycleDayOnDate(HISTORY, "2026-01-29")).toBe(1);
    expect(cycleDayOnDate(HISTORY, "2026-01-30")).toBe(2);
  });

  it("keeps counting into the open cycle from the latest start", () => {
    expect(cycleDayOnDate(HISTORY, "2026-02-26")).toBe(1);
    expect(cycleDayOnDate(HISTORY, "2026-03-10")).toBe(13);
  });
});

describe("cyclePhaseOnDate", () => {
  it("returns null before any recorded period", () => {
    expect(phaseOn(HISTORY, "2025-12-31")).toBeNull();
  });

  it("is menstrual within a recorded period (inclusive endpoints)", () => {
    expect(phaseOn(HISTORY, "2026-01-01")).toBe("menstrual");
    expect(phaseOn(HISTORY, "2026-01-05")).toBe("menstrual");
    expect(phaseOn(HISTORY, "2026-01-29")).toBe("menstrual");
  });

  it("is follicular just after a period, luteal in the ~14 days before the next", () => {
    // Cycle 1: 2026-01-01 → next start 2026-01-29. Luteal window = last 14 days before
    // 01-29, i.e. from 2026-01-15 onward.
    expect(phaseOn(HISTORY, "2026-01-06")).toBe("follicular");
    expect(phaseOn(HISTORY, "2026-01-14")).toBe("follicular");
    expect(phaseOn(HISTORY, "2026-01-15")).toBe("luteal");
    expect(phaseOn(HISTORY, "2026-01-28")).toBe("luteal");
  });

  it("does NOT claim luteal for the OPEN cycle (no forecast) — follicular after the period", () => {
    // Last logged period is cycle 3 (open beyond its end). Any date after its end is
    // follicular, never luteal, because there is no next period to anchor ovulation.
    const day40 = "2026-03-20"; // well past a typical follicular span
    expect(phaseOn(HISTORY, day40)).toBe("follicular");
  });

  it("treats an ongoing period (null end) as menstrual within the plausible window", () => {
    const open: CyclePeriod[] = [period(9, "2026-04-01", null)];
    expect(phaseOn(open, "2026-04-01")).toBe("menstrual");
    expect(phaseOn(open, "2026-04-03")).toBe("menstrual");
  });

  // #1682 fix a — a forgotten "Period ended" tap must not claim menstrual forever. The
  // record is left EXACTLY as stored; only the claim lapses.
  it("withdraws the menstrual claim past MAX_PLAUSIBLE_PERIOD_DAYS (day 10 vs 11)", () => {
    const open: CyclePeriod[] = [period(9, "2026-04-01", null)];
    expect(MAX_PLAUSIBLE_PERIOD_DAYS).toBe(10);
    // Day 10 is 04-10 (the start day is day 1) — still the last plausible bleeding day.
    expect(phaseOn(open, "2026-04-10")).toBe("menstrual");
    expect(periodOnDate(open, "2026-04-10")?.id).toBe(9);
    expect(isStaleOpenPeriod(open[0], "2026-04-10")).toBe(false);
    // Day 11 — the claim lapses and the date derives as it would with no open claim.
    expect(phaseOn(open, "2026-04-11")).toBe("follicular");
    expect(periodOnDate(open, "2026-04-11")).toBeNull();
    expect(isStaleOpenPeriod(open[0], "2026-04-11")).toBe(true);
    // The row itself is untouched — withdrawal is a read-side decision, never a write.
    expect(open[0].period_end).toBeNull();
    // Cycle DAY still counts from the logged start: the start is a fact, the coverage
    // was the claim.
    expect(cycleDayOnDate(open, "2026-04-11")).toBe(11);
  });

  it("still resolves luteal retrospectively once a next period follows a stale open one", () => {
    // A stale open period followed by a real next start: the days before that next start
    // derive normally rather than being swallowed by the lapsed claim.
    const rows = [
      period(1, "2026-04-01", null),
      period(2, "2026-05-01", "2026-05-05"),
    ];
    expect(phaseOn(rows, "2026-04-11")).toBe("follicular");
    expect(phaseOn(rows, "2026-04-20")).toBe("luteal"); // 05-01 minus 14 = 04-17
  });

  it("a closed period is unaffected by the plausibility cap (long periods stay stored)", () => {
    // #1682 fix b: a long RECORDED period is stored and honored as entered — it is
    // observed by a coaching finding, never withdrawn or refused.
    const long = [period(4, "2026-04-01", "2026-04-20")];
    expect(phaseOn(long, "2026-04-18")).toBe("menstrual");
    expect(periodOnDate(long, "2026-04-18")?.id).toBe(4);
    expect(isStaleOpenPeriod(long[0], "2026-04-18")).toBe(false);
  });

  it("uses LUTEAL_PHASE_DAYS as the follicular/luteal boundary from the next start", () => {
    const two = [
      period(1, "2026-05-01", "2026-05-05"),
      period(2, "2026-06-01", null),
    ];
    // next start 06-01; boundary = 06-01 minus 14 = 05-18.
    expect(phaseOn(two, "2026-05-17")).toBe("follicular");
    expect(phaseOn(two, "2026-05-18")).toBe("luteal");
    expect(LUTEAL_PHASE_DAYS).toBe(14);
  });
});

// #2613 — the derivation is retrospective, and a date after `today` is not merely
// uncertain, it is unknowable: several periods will have happened in between. The
// answer there is an ABSENCE (the chip renders nothing), never a hedged phase.
describe("cyclePhaseOnDate refuses a future date (#2613)", () => {
  const OPEN: CyclePeriod[] = [period(1, "2026-03-01", "2026-03-05")];

  it("answers null for a date after today, where the open-cycle branch used to say follicular", () => {
    // The exact shape the Timeline fed it: a goal target date months out, landing in
    // the open cycle (no following period logged), which answered with total
    // confidence about a day nobody has lived.
    expect(phaseOn(OPEN, "2026-12-10", "2026-08-12")).toBeNull();
    expect(phaseOn(OPEN, "2026-08-13", "2026-08-12")).toBeNull();
    // Same date, once it has actually arrived — the derivation is unchanged.
    expect(phaseOn(OPEN, "2026-12-10", "2026-12-10")).toBe("follicular");
  });

  it("still answers for today itself and for every day before it", () => {
    expect(phaseOn(OPEN, "2026-08-12", "2026-08-12")).toBe("follicular");
    expect(phaseOn(OPEN, "2026-03-03", "2026-08-12")).toBe("menstrual");
  });

  it("refuses a future date even when a logged period would cover it", () => {
    // An ongoing period's plausible window can extend past today; that is a claim
    // about days already bled through, not a licence to call tomorrow menstrual.
    const ongoing: CyclePeriod[] = [period(2, "2026-08-11", null)];
    expect(phaseOn(ongoing, "2026-08-12", "2026-08-12")).toBe("menstrual");
    expect(phaseOn(ongoing, "2026-08-14", "2026-08-12")).toBeNull();
  });

  it("refuses a future date that a LATER logged period would make luteal", () => {
    // The refusal is about the horizon, not about which branch would have answered:
    // a date inside a completed cycle is still refused when it is ahead of today.
    const two: CyclePeriod[] = [
      period(1, "2026-05-01", "2026-05-05"),
      period(2, "2026-06-01", "2026-06-05"),
    ];
    expect(phaseOn(two, "2026-05-20", "2026-06-30")).toBe("luteal");
    expect(phaseOn(two, "2026-05-20", "2026-05-10")).toBeNull();
  });

  it("refuses before it consults the log at all — an empty log answers null either way", () => {
    expect(phaseOn([], "2026-12-10", "2026-08-12")).toBeNull();
    expect(phaseOn([], "2026-08-01", "2026-08-12")).toBeNull();
  });
});

describe("periodOnDate", () => {
  it("returns the covering period or null", () => {
    expect(periodOnDate(HISTORY, "2026-01-03")?.id).toBe(1);
    expect(periodOnDate(HISTORY, "2026-01-10")).toBeNull();
    expect(periodOnDate(HISTORY, "2026-02-27")?.id).toBe(3);
  });
});

describe("cycleLengths", () => {
  it("computes day gaps between consecutive period starts (completed cycles only)", () => {
    expect(cycleLengths(HISTORY).map((l) => l.days)).toEqual([28, 28]);
  });

  it("is empty with fewer than two periods", () => {
    expect(cycleLengths([period(1, "2026-01-01", "2026-01-05")])).toEqual([]);
  });
});

describe("periodLengthDays", () => {
  it("counts inclusive bleeding days, null while ongoing", () => {
    expect(periodLengthDays(period(1, "2026-01-01", "2026-01-05"))).toBe(5);
    expect(periodLengthDays(period(1, "2026-01-01", "2026-01-01"))).toBe(1);
    expect(periodLengthDays(period(1, "2026-01-01", null))).toBeNull();
  });
});

describe("cycleStats", () => {
  it("reports insufficient below 3 length samples", () => {
    expect(cycleStats(HISTORY).regularity).toBe("insufficient"); // only 2 lengths
    expect(cycleStats([]).cycleCount).toBe(0);
  });

  it("reads regular when the spread is within the threshold", () => {
    const reg: CyclePeriod[] = [
      period(1, "2026-01-01", "2026-01-05"),
      period(2, "2026-01-29", "2026-02-02"), // 28
      period(3, "2026-02-26", "2026-03-02"), // 28
      period(4, "2026-03-27", "2026-03-31"), // 29
    ];
    const s = cycleStats(reg);
    expect(s.cycleCount).toBe(3);
    expect(s.minLength).toBe(28);
    expect(s.maxLength).toBe(29);
    expect(s.variabilityDays).toBe(1);
    expect(s.regularity).toBe("regular");
  });

  it("reads irregular when the spread exceeds the threshold", () => {
    const irr: CyclePeriod[] = [
      period(1, "2026-01-01", "2026-01-05"),
      period(2, "2026-01-25", "2026-01-29"), // 24
      period(3, "2026-03-01", "2026-03-05"), // 35
      period(4, "2026-03-27", "2026-03-31"), // 26
    ];
    const s = cycleStats(irr);
    expect(s.variabilityDays).toBeGreaterThan(7);
    expect(s.regularity).toBe("irregular");
  });
});

describe("isFlowLevel", () => {
  it("accepts the three levels and rejects anything else", () => {
    expect(isFlowLevel("light")).toBe(true);
    expect(isFlowLevel("heavy")).toBe(true);
    expect(isFlowLevel("spotting")).toBe(false);
    expect(isFlowLevel(null)).toBe(false);
  });
});
