import { describe, it, expect } from "vitest";
import {
  STEPS_AFTERNOON_HOUR,
  STEPS_BEHIND_FRACTION,
  STEPS_STALE_AFTER_MIN,
  stepsBehindByAfternoon,
  stepsBehindDetail,
  stepsPaceKey,
  stepsTodayTargetLine,
  stepsVerdict,
  stepsVerdictLine,
} from "@/lib/steps-target";

// #1723 part 2 — the daily step target's pure decisions. No DB, no clock.

describe("stepsVerdictLine — met / under / no-target", () => {
  it("states the verdict when the target is met", () => {
    expect(stepsVerdictLine(8400, 8000)).toBe("8,400 steps ▲ target met");
  });

  it("states both numbers when it isn't", () => {
    expect(stepsVerdictLine(5100, 8000)).toBe("5,100 of 8,000 steps");
  });

  it("exactly the target counts as met", () => {
    expect(stepsVerdict(8000, 8000)).toBe("met");
    expect(stepsVerdict(7999, 8000)).toBe("under");
  });

  it("NO TARGET renders no line — the digest never prints a lonely number", () => {
    expect(stepsVerdictLine(8400, null)).toBeNull();
    expect(stepsVerdictLine(8400, 0)).toBeNull();
  });

  it("no reading renders no line", () => {
    expect(stepsVerdictLine(null, 8000)).toBeNull();
  });

  it("carries no streak, no grade and no encouragement", () => {
    const met = stepsVerdictLine(9000, 8000)!;
    const under = stepsVerdictLine(1000, 8000)!;
    for (const line of [met, under]) {
      expect(line).not.toMatch(
        /streak|days in a row|great|well done|keep it up|nice/i
      );
    }
  });
});

describe("stepsBehindByAfternoon — every clause is a veto", () => {
  const base = {
    hourLocal: STEPS_AFTERNOON_HOUR,
    stepsSoFar: 1000,
    target: 8000,
    dataAgeMin: 10,
  };

  it("fires when the afternoon has arrived and the day is well behind", () => {
    expect(stepsBehindByAfternoon(base)).toBe(true);
  });

  it("stays silent before the evaluation hour", () => {
    expect(
      stepsBehindByAfternoon({ ...base, hourLocal: STEPS_AFTERNOON_HOUR - 1 })
    ).toBe(false);
  });

  it("stays silent with no declared target", () => {
    expect(stepsBehindByAfternoon({ ...base, target: null })).toBe(false);
    expect(stepsBehindByAfternoon({ ...base, target: 0 })).toBe(false);
  });

  it("STALE DATA is silence, not a verdict — a late batch must not fire a false behind", () => {
    expect(
      stepsBehindByAfternoon({
        ...base,
        dataAgeMin: STEPS_STALE_AFTER_MIN + 1,
      })
    ).toBe(false);
    expect(stepsBehindByAfternoon({ ...base, dataAgeMin: null })).toBe(false);
    // Fresh at the boundary still speaks.
    expect(
      stepsBehindByAfternoon({ ...base, dataAgeMin: STEPS_STALE_AFTER_MIN })
    ).toBe(true);
  });

  it("no steps recorded at all is silence, not zero", () => {
    expect(stepsBehindByAfternoon({ ...base, stepsSoFar: null })).toBe(false);
  });

  it("an on-track day says nothing", () => {
    const half = 8000 * STEPS_BEHIND_FRACTION;
    expect(stepsBehindByAfternoon({ ...base, stepsSoFar: half })).toBe(false);
    expect(stepsBehindByAfternoon({ ...base, stepsSoFar: half - 1 })).toBe(
      true
    );
  });

  it("detail states the two numbers and nothing else", () => {
    expect(stepsBehindDetail(1200, 8000)).toBe("1,200 of 8,000 today");
  });

  it("keys per day, so a dismissal never carries into tomorrow", () => {
    expect(stepsPaceKey("2026-07-31")).toBe("steps-pace:2026-07-31");
    expect(stepsPaceKey("2026-08-01")).not.toBe(stepsPaceKey("2026-07-31"));
  });
});

describe("stepsTodayTargetLine — informative or absent", () => {
  it("speaks when the trailing average sits below the target", () => {
    expect(stepsTodayTargetLine({ target: 8000, average7: 6200 })).toBe(
      "Step target 8,000 — you've averaged 6,200 a day this past week."
    );
  });

  it("stays quiet when the reader already clears the target on an average day", () => {
    expect(stepsTodayTargetLine({ target: 8000, average7: 8000 })).toBeNull();
    expect(stepsTodayTargetLine({ target: 8000, average7: 9500 })).toBeNull();
  });

  it("stays quiet with no target and with no history", () => {
    expect(stepsTodayTargetLine({ target: null, average7: 4000 })).toBeNull();
    expect(stepsTodayTargetLine({ target: 8000, average7: null })).toBeNull();
  });
});
