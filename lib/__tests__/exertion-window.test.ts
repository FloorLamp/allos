import { describe, expect, it } from "vitest";
import {
  detectedWorkoutEnd,
  exertionWindows,
  EXERTION_MAX_GAP_MIN,
  type ExertionSample,
} from "@/lib/exertion-window";

// #5113 — what the heart rate says a session was.
//
// The two rules doing the work are the two asserted hardest: a window needs QUIET on
// both sides, measured rather than assumed, and a coverage gap is not recovery. Both
// exist to stop a confident window over minutes nobody recorded — which looks exactly
// like a real one.

const MIN = 60_000;
const T0 = Date.parse("2026-09-03T08:00:00Z");
const CEILING = 70;

/** Minutes from `fromMin` to `toMin` at `bpm`, appended to `into`. */
function minutes(
  into: ExertionSample[],
  fromMin: number,
  toMin: number,
  bpm: number
): ExertionSample[] {
  for (let m = fromMin; m < toMin; m++) into.push({ at: T0 + m * MIN, bpm });
  return into;
}

const at = (m: number) => T0 + m * MIN;

/** Quiet 0–30, effort 30–90, quiet 90–120. */
function oneEffort(): ExertionSample[] {
  const out: ExertionSample[] = [];
  minutes(out, 0, 30, 55);
  minutes(out, 30, 90, 120);
  minutes(out, 90, 120, 55);
  return out;
}

const BASE = {
  ceilingBpm: CEILING,
  usualRecoveryMin: 15,
  minWindowMin: 20,
  claimed: [] as { from: number; to: number }[],
};

describe("exertionWindows", () => {
  it("finds an effort bounded by quiet on both sides", () => {
    expect(exertionWindows({ ...BASE, samples: oneEffort() })).toEqual([
      { from: at(30), to: at(90) },
    ]);
  });

  it("yields nothing while the effort is still running at the frontier", () => {
    // The trace ends elevated: this is a session in progress, and the whole point of
    // the feature is that it does not finish one.
    const samples = minutes(minutes([], 0, 30, 55), 30, 90, 120);
    expect(exertionWindows({ ...BASE, samples })).toEqual([]);
  });

  it("yields nothing for an effort already under way at the trace's first minute", () => {
    // The mirror of the frontier rule. Nothing says the effort began where the trace
    // did, so there is no window to state — only a stretch of unknown provenance.
    const samples = minutes(minutes([], 0, 60, 120), 60, 120, 55);
    expect(exertionWindows({ ...BASE, samples })).toEqual([]);
  });

  it("refuses an effort whose own minutes have a gap in them", () => {
    // A wrist that came off. `covered` is what the honesty gate buys: the answer to
    // "what did this heart rate do" over minutes nobody measured is not a window.
    const out: ExertionSample[] = [];
    minutes(out, 0, 30, 55);
    minutes(out, 30, 45, 120);
    minutes(out, 45 + EXERTION_MAX_GAP_MIN + 1, 90, 120);
    minutes(out, 90, 120, 55);
    expect(exertionWindows({ ...BASE, samples: out })).toEqual([]);
  });

  it("refuses an effort whose quiet stretch is not measured either", () => {
    // The gap moved into the recovery. "Did they come back down" over missing minutes
    // is unknown, and unknown is not yes.
    const out: ExertionSample[] = [];
    minutes(out, 0, 30, 55);
    minutes(out, 30, 90, 120);
    minutes(out, 90, 92, 55);
    minutes(out, 92 + EXERTION_MAX_GAP_MIN + 1, 120, 55);
    expect(exertionWindows({ ...BASE, samples: out })).toEqual([]);
  });

  it("refuses a span under this profile's own floor", () => {
    // Fifteen minutes of effort on a profile whose own shortest sessions run 20.
    const out: ExertionSample[] = [];
    minutes(out, 0, 30, 55);
    minutes(out, 30, 45, 120);
    minutes(out, 45, 120, 55);
    expect(exertionWindows({ ...BASE, samples: out })).toEqual([]);
    // …and the SAME trace is a window for someone whose sessions are that short.
    expect(
      exertionWindows({ ...BASE, samples: out, minWindowMin: null })
    ).toEqual([{ from: at(30), to: at(45) }]);
  });

  it("drops a span a logged row already accounts for, whole", () => {
    // Two efforts, one of them logged. The claimed one goes entirely — a session
    // logged over part of an effort IS that effort, and offering the remainder would
    // invite two rows for one workout.
    const out: ExertionSample[] = [];
    minutes(out, 0, 30, 55);
    minutes(out, 30, 90, 120);
    minutes(out, 90, 150, 55);
    minutes(out, 150, 200, 120);
    minutes(out, 200, 240, 55);
    expect(
      exertionWindows({
        ...BASE,
        samples: out,
        claimed: [{ from: at(40), to: at(60) }],
      })
    ).toEqual([{ from: at(150), to: at(200) }]);
  });

  it("uses the person's own recovery, not a constant", () => {
    // Twelve quiet minutes closes the span for someone who usually takes ten, and does
    // not for someone who usually takes twenty — same trace, two honest answers.
    const out: ExertionSample[] = [];
    minutes(out, 0, 30, 55);
    minutes(out, 30, 90, 120);
    minutes(out, 90, 102, 55);
    minutes(out, 102, 140, 120);
    minutes(out, 140, 180, 55);
    expect(
      exertionWindows({ ...BASE, samples: out, usualRecoveryMin: 10 })
    ).toEqual([
      { from: at(30), to: at(90) },
      { from: at(102), to: at(140) },
    ]);
    expect(
      exertionWindows({ ...BASE, samples: out, usualRecoveryMin: 20 })
    ).toEqual([]);
  });

  it("uses a recovery SHORTER than the no-history default, and the person gets both efforts", () => {
    // The case above only exercises usuals at or above the default, where a default
    // read as a minimum and a default read as a default agree. This is the one that
    // tells them apart, and it is the harm: two efforts eight quiet minutes apart, on
    // someone whose own measured recovery is six. Their own number closes both spans.
    // Floored up to ten, NEITHER span finds its quiet — the second effort sits inside
    // the first's recovery and vice versa — and a fast-recovering person gets nothing
    // at all from a module whose whole claim is that it answers per person.
    const out: ExertionSample[] = [];
    minutes(out, 0, 30, 55);
    minutes(out, 30, 60, 120);
    minutes(out, 60, 68, 55);
    minutes(out, 68, 100, 120);
    minutes(out, 100, 130, 55);
    expect(
      exertionWindows({ ...BASE, samples: out, usualRecoveryMin: 6 })
    ).toEqual([
      { from: at(30), to: at(60) },
      { from: at(68), to: at(100) },
    ]);
    // And the SAME trace says nothing for a profile with no recovery of their own,
    // who is held to the ten-minute default. That is the answer the person above was
    // being given, and the only person it is honest to give it to.
    expect(
      exertionWindows({ ...BASE, samples: out, usualRecoveryMin: null })
    ).toEqual([]);
  });

  it("uses a floor SHORTER than the no-history default, for someone whose sessions are that short", () => {
    // Seven minutes is a session for a profile whose own shortest logged sessions run
    // seven. `EXERTION_MIN_WINDOW_DEFAULT_MIN` is what someone with nothing logged
    // gets, not a bar everyone else has to clear as well.
    const out: ExertionSample[] = [];
    minutes(out, 0, 30, 55);
    minutes(out, 30, 37, 120);
    minutes(out, 37, 70, 55);
    expect(
      exertionWindows({ ...BASE, samples: out, minWindowMin: 7 })
    ).toEqual([{ from: at(30), to: at(37) }]);
    // Same trace, a profile with nothing logged: the default applies and says no.
    expect(
      exertionWindows({ ...BASE, samples: out, minWindowMin: null })
    ).toEqual([]);
  });
});

describe("detectedWorkoutEnd", () => {
  it("reads the end off the trace once the quiet after it has arrived", () => {
    expect(
      detectedWorkoutEnd({
        ...BASE,
        samples: oneEffort(),
        startedAt: at(30),
        lastSetAt: null,
      })
    ).toBe(at(90));
  });

  it("says nothing while the session is still elevated", () => {
    const samples = minutes(minutes([], 0, 30, 55), 30, 90, 120);
    expect(
      detectedWorkoutEnd({
        ...BASE,
        samples,
        startedAt: at(30),
        lastSetAt: null,
      })
    ).toBeNull();
  });

  it("says nothing while the quiet is still shorter than this person's recovery", () => {
    const out: ExertionSample[] = [];
    minutes(out, 0, 30, 55);
    minutes(out, 30, 90, 120);
    minutes(out, 90, 100, 55);
    expect(
      detectedWorkoutEnd({
        ...BASE,
        samples: out,
        startedAt: at(30),
        lastSetAt: null,
      })
    ).toBeNull();
  });

  it("says nothing when the quiet is not measured", () => {
    const out: ExertionSample[] = [];
    minutes(out, 0, 30, 55);
    minutes(out, 30, 90, 120);
    minutes(out, 90, 92, 55);
    minutes(out, 92 + EXERTION_MAX_GAP_MIN + 1, 120, 55);
    expect(
      detectedWorkoutEnd({
        ...BASE,
        samples: out,
        startedAt: at(30),
        lastSetAt: null,
      })
    ).toBeNull();
  });

  it("is cancelled by a set logged after the candidate minute", () => {
    // THE RULE THAT KEEPS THIS FROM FINISHING SOMEBODY MID-WORKOUT. A long rest can
    // reach the resting range; the next set is proof the session had not ended there.
    expect(
      detectedWorkoutEnd({
        ...BASE,
        samples: oneEffort(),
        startedAt: at(30),
        lastSetAt: at(95),
      })
    ).toBeNull();
    // A set BEFORE it is the ordinary case and changes nothing.
    expect(
      detectedWorkoutEnd({
        ...BASE,
        samples: oneEffort(),
        startedAt: at(30),
        lastSetAt: at(85),
      })
    ).toBe(at(90));
  });

  it("takes the LAST elevated minute, not the first rest", () => {
    // A rest that dips inside the range mid-session is not an end; the session ends
    // where the elevation finally stops.
    const out: ExertionSample[] = [];
    minutes(out, 0, 30, 55);
    minutes(out, 30, 50, 120);
    minutes(out, 50, 55, 60);
    minutes(out, 55, 90, 120);
    minutes(out, 90, 120, 55);
    expect(
      detectedWorkoutEnd({
        ...BASE,
        samples: out,
        startedAt: at(30),
        lastSetAt: null,
      })
    ).toBe(at(90));
  });

  it("says nothing for a bare wrist — no minutes past the start", () => {
    // The 45-minute stale suggest stays the fallback; the trace decides or nothing does.
    expect(
      detectedWorkoutEnd({
        ...BASE,
        samples: minutes([], 0, 30, 55),
        startedAt: at(60),
        lastSetAt: null,
      })
    ).toBeNull();
  });
});
