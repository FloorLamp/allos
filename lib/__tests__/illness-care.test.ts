import { describe, it, expect } from "vitest";
import { shiftDateStr } from "@/lib/date";
import type {
  AssembledEpisode,
  SymptomSeries,
} from "@/lib/illness-episode-format";
import {
  detectIllnessCareFindings,
  trailingRisingRun,
  illnessCareDedupeKey,
  planIllnessCareNudges,
  ILLNESS_CARE_PREFIX,
} from "@/lib/illness-care";

// Pure boundary tests for the illness-care engine (#805). No DB — hand-built
// AssembledEpisode fixtures over the committed dataset (fever: duration 3 days +
// infant band; diarrhea: duration 2 days + trajectory; headache: NO entry).

const START = "2026-07-10";

function seriesOf(
  symptom: string,
  severities: number[],
  opts: { start?: string; gapAfter?: number } = {}
): SymptomSeries {
  const start = opts.start ?? START;
  // gapAfter: insert a 2-day jump after that index so the run isn't consecutive.
  let cursor = 0;
  const points = severities.map((sev, i) => {
    if (opts.gapAfter != null && i === opts.gapAfter + 1) cursor += 2;
    const date = shiftDateStr(start, cursor);
    cursor += 1;
    return { date, severity: sev, note: null };
  });
  return {
    symptom,
    label: symptom,
    points,
    maxSeverity: Math.max(...severities, 0),
  };
}

function makeEpisode(
  symptoms: SymptomSeries[],
  opts: { situation?: string; start?: string | null } = {}
): AssembledEpisode {
  const start = opts.start === undefined ? START : opts.start;
  return {
    id: null,
    situation: opts.situation ?? "Flu",
    start,
    end: null,
    ongoing: true,
    firstDay: start,
    lastActiveDay: START,
    asOf: START,
    dayCount: null,
    symptoms,
    distinctSymptomCount: symptoms.length,
    temperatures: [],
    maxTempF: null,
    latestTemp: null,
    medications: [],
    totalAdministrations: 0,
    conditions: [],
    notes: [],
  };
}

describe("detectIllnessCareFindings — duration variant", () => {
  it("day N-1 (== threshold) does NOT fire; day N (> threshold) fires", () => {
    // fever duration.days = 3 → fires when logged MORE THAN 3 consecutive days.
    const three = detectIllnessCareFindings(
      makeEpisode([seriesOf("fever", [2, 2, 2])]),
      { ageMonths: null }
    );
    expect(three.filter((f) => f.variant === "duration")).toHaveLength(0);

    const four = detectIllnessCareFindings(
      makeEpisode([seriesOf("fever", [2, 2, 2, 2])]),
      { ageMonths: null }
    );
    const dur = four.filter((f) => f.variant === "duration");
    expect(dur).toHaveLength(1);
    expect(dur[0].symptom).toBe("fever");
    expect(dur[0].runDays).toBe(4);
    expect(dur[0].title).toContain("4 days running");
    expect(dur[0].dedupeKey.startsWith(ILLNESS_CARE_PREFIX)).toBe(true);
  });

  it("a gap breaks the consecutive run", () => {
    // 5 fever days but with a gap after index 1 → trailing consecutive run is 3.
    const findings = detectIllnessCareFindings(
      makeEpisode([seriesOf("fever", [2, 2, 2, 2, 2], { gapAfter: 1 })]),
      { ageMonths: null }
    );
    // Trailing run is 3 (not > 3), so no duration finding.
    expect(findings.filter((f) => f.variant === "duration")).toHaveLength(0);
  });

  it("a symptom with NO dataset entry never fires", () => {
    const findings = detectIllnessCareFindings(
      makeEpisode([seriesOf("headache", [3, 3, 3, 3, 3, 3, 3, 3, 3, 3])]),
      { ageMonths: null }
    );
    expect(findings).toHaveLength(0);
  });
});

describe("detectIllnessCareFindings — trajectory (worsening) variant", () => {
  const variants = (severities: number[]) =>
    detectIllnessCareFindings(makeEpisode([seriesOf("diarrhea", severities)]), {
      ageMonths: null,
    })
      .filter((f) => f.symptom === "diarrhea")
      .map((f) => f.variant);

  it("rising severity ≥ M consecutive days fires the worsening variant", () => {
    // diarrhea trajectory.days = 2 → needs 2 rising steps (3 worsening days).
    expect(variants([1, 2, 3])).toContain("trajectory");
  });

  it("plateau does NOT fire the worsening variant", () => {
    expect(variants([2, 2, 2])).not.toContain("trajectory");
  });

  it("falling severity does NOT fire the worsening variant", () => {
    expect(variants([3, 2, 1])).not.toContain("trajectory");
  });
});

describe("trailingRisingRun", () => {
  it("counts consecutive strictly-increasing steps ending at the last reading", () => {
    expect(trailingRisingRun([1, 2, 3])).toBe(2);
    expect(trailingRisingRun([1, 1, 2])).toBe(1);
    expect(trailingRisingRun([2, 2, 2])).toBe(0);
    expect(trailingRisingRun([3, 2, 1])).toBe(0);
    expect(trailingRisingRun([1, 3, 3])).toBe(0); // last step is a plateau
    expect(trailingRisingRun([5])).toBe(0);
    expect(trailingRisingRun([])).toBe(0);
  });
});

describe("detectIllnessCareFindings — infant age band (source-published)", () => {
  it("an infant under the source's floor gets the refusal for ANY logged day, superseding the number", () => {
    // fever logged just 1 day; infant (age 2 months, floor 3 months).
    const findings = detectIllnessCareFindings(
      makeEpisode([seriesOf("fever", [1])]),
      { ageMonths: 2 }
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].variant).toBe("infant");
    // Even a long streak stays the infant refusal, never the adult "N days" count.
    const long = detectIllnessCareFindings(
      makeEpisode([seriesOf("fever", [2, 2, 2, 2, 2])]),
      { ageMonths: 2 }
    );
    expect(long.map((f) => f.variant)).toEqual(["infant"]);
  });

  it("unknown age never triggers the infant band (falls back to the adult rule)", () => {
    const findings = detectIllnessCareFindings(
      makeEpisode([seriesOf("fever", [1])]),
      { ageMonths: null }
    );
    expect(findings).toHaveLength(0); // 1 day is below the adult 3-day line
  });

  it("a child above the floor uses the adult duration rule, not the infant band", () => {
    const findings = detectIllnessCareFindings(
      makeEpisode([seriesOf("fever", [2, 2, 2, 2])]),
      { ageMonths: 12 }
    );
    expect(findings.map((f) => f.variant)).toEqual(["duration"]);
  });
});

describe("illnessCareDedupeKey", () => {
  it("is episode-anchored (situation + start) and namespace-prefixed", () => {
    expect(illnessCareDedupeKey("Flu", "2026-07-10", "fever", "duration")).toBe(
      "illness-care:duration:flu:2026-07-10:fever"
    );
    // An open episode with unknown start anchors on "open".
    expect(illnessCareDedupeKey("Cold", null, "cough", "trajectory")).toBe(
      "illness-care:trajectory:cold:open:cough"
    );
  });
});

describe("planIllnessCareNudges", () => {
  it("sends unmarked, un-suppressed findings; clears stale markers; freezes suppressed", () => {
    const plan = planIllnessCareNudges(
      ["k:new", "k:marked", "k:suppressed"],
      ["k:marked", "k:suppressed", "k:stale"],
      ["k:suppressed"]
    );
    expect(plan.toSend).toEqual(["k:new"]);
    // stale marker (no longer actionable) cleared; suppressed marker frozen (kept).
    expect(plan.toClear).toEqual(["k:stale"]);
  });
});
