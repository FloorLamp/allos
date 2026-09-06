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
    expect(exertionWindows({ ...BASE, samples: out, minWindowMin: 7 })).toEqual(
      [{ from: at(30), to: at(37) }]
    );
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

  // TWO EFFORTS IN ONE TRACE (#5289). Every fixture above holds a single effort, which
  // is why "the effort that contains the start" and "the last elevated minute of
  // whatever you were handed" agreed for as long as they did — the caller was bounding
  // the trace, and the divergence was unobservable in this suite. These two are the
  // trace that tells them apart: the answer moves by more than an hour between them.
  function twoEfforts(): ExertionSample[] {
    const out: ExertionSample[] = [];
    minutes(out, 0, 30, 55);
    minutes(out, 30, 90, 120); // the session
    minutes(out, 90, 130, 55); // forty minutes of rest, longer than the recovery
    minutes(out, 130, 160, 130); // a later run, a different effort
    minutes(out, 160, 200, 55);
    return out;
  }

  it("says nothing when the trace holds a later effort too", () => {
    // The morning session ended at 09:30 and the evening run is not its tail — but
    // PICKING the first is a mechanism, and three rounds of passes each broke one. The
    // trace holds two efforts, so it does not say which one this row was, and the
    // person finishes it themselves.
    expect(
      detectedWorkoutEnd({
        ...BASE,
        samples: twoEfforts(),
        startedAt: at(30),
        lastSetAt: null,
      })
    ).toBeNull();
  });

  it("ends the LATER effort when that is the one the start is in", () => {
    // The same trace, read for a row that began in the second effort — so the rule is
    // "the effort containing the start" rather than "the first effort in the trace".
    expect(
      detectedWorkoutEnd({
        ...BASE,
        samples: twoEfforts(),
        startedAt: at(130),
        lastSetAt: null,
      })
    ).toBe(at(160));
  });

  // THE START MUST BE INSIDE THE EFFORT (#5212 third pass, R1). "The effort that
  // contains the start" was really "the first effort at or after the start", so a row
  // started at 08:00 whose trace has nothing elevated until an evening run was answered
  // with the run's end — eleven hours of one session, written unattended.
  it("says nothing when the trace does not begin until hours after the start", () => {
    // THE WRIST GOES ON MID-RUN. Nothing before it was measured, so the first thing this
    // trace can say is about a run at six — and a row started at eight in the morning is
    // not that run, however unambiguously it reads on its own. Without this the module
    // answers 19:00 for an 08:00 session: eleven hours, written unattended.
    const out: ExertionSample[] = [];
    minutes(out, 600, 660, 130);
    minutes(out, 660, 700, 55);
    expect(
      detectedWorkoutEnd({
        ...BASE,
        samples: out,
        startedAt: at(0),
        lastSetAt: null,
      })
    ).toBeNull();
  });

  it("says nothing when the start is in no effort at all", () => {
    // MEASURED THROUGHOUT, deliberately: a gap here would be refused by the coverage
    // rule instead and this case would stop testing the bound it is for. The trace says
    // this person was inside their own resting range for ten hours after they started
    // the row, and then went for a run.
    const out: ExertionSample[] = [];
    minutes(out, 0, 660, 55);
    minutes(out, 660, 720, 120); // an evening run
    minutes(out, 720, 780, 55);
    expect(
      detectedWorkoutEnd({
        ...BASE,
        samples: out,
        startedAt: at(0),
        lastSetAt: null,
      })
    ).toBeNull();
  });

  it("says nothing when the first measured minutes are inside the resting range", () => {
    // THE COST OF THE SIMPLIFICATION, PINNED RATHER THAN LEFT TO BE DISCOVERED. A
    // ten-minute warm-up below this person's own ceiling used to be answered by a rule
    // that looked past it; that rule is gone and the trace has to begin elevated. They
    // finish this session themselves, which is the trade the module took over a fourth
    // mechanism for looking past the start.
    const out: ExertionSample[] = [];
    minutes(out, 0, 10, 55);
    minutes(out, 10, 70, 120);
    minutes(out, 70, 110, 55);
    expect(
      detectedWorkoutEnd({
        ...BASE,
        samples: out,
        startedAt: at(0),
        lastSetAt: null,
      })
    ).toBeNull();
  });

  it("says nothing when the minutes between the start and the effort are unmeasured", () => {
    // Coverage is not quiet, at the OPENING edge too: nothing says the effort that
    // begins at :10 is the one this row started, when nobody measured :02 to :09.
    const out: ExertionSample[] = [];
    minutes(out, 0, 2, 55);
    minutes(out, 10, 40, 120);
    minutes(out, 40, 80, 55);
    expect(
      detectedWorkoutEnd({
        ...BASE,
        samples: out,
        startedAt: at(0),
        lastSetAt: null,
      })
    ).toBeNull();
  });

  // A REST BETWEEN HEAVY SETS IS A SECOND EFFORT TO THIS TRACE (#5212 third pass, R2).
  // Segmenting it and answering the first half is what finished somebody mid-workout,
  // reaching the safety-tier post-workout dispatch; answering the second half would end
  // a session at a later effort's minute. Both readings are refused now.
  function restThenBackAtIt(): ExertionSample[] {
    const out: ExertionSample[] = [];
    minutes(out, 0, 35, 120); // the session
    minutes(out, 35, 55, 55); // a rest longer than the recovery
    minutes(out, 55, 65, 140); // and they are lifting again
    return out;
  }

  it("says nothing while the trace is elevated at its frontier", () => {
    expect(
      detectedWorkoutEnd({
        ...BASE,
        samples: restThenBackAtIt(),
        startedAt: at(0),
        lastSetAt: null,
      })
    ).toBeNull();
  });

  it("says nothing at the frontier even when the recovery is shorter than a gap", () => {
    // THE FRONTIER RULE EARNS ITS OWN LINE HERE. For most profiles the candidate's
    // closing-quiet test already refuses a trace that ends elevated, because quiet past
    // the frontier is unmeasured. For a profile whose own recovery is SHORTER than the
    // coverage bound it does not: four minutes past the last sample is inside the gap
    // this file forgives, so the quiet reads as satisfied and only the frontier test is
    // left to say that this person is lifting right now.
    //
    // ONE effort, deliberately — a second one is refused before the frontier test is
    // reached, and this case would stop testing it.
    expect(
      detectedWorkoutEnd({
        ...BASE,
        usualRecoveryMin: 4,
        samples: minutes([], 0, 55, 120),
        startedAt: at(0),
        lastSetAt: null,
      })
    ).toBeNull();
  });

  it("says nothing about that same trace once it comes to rest, either", () => {
    // The cool-down lets the frontier rule through and the answer is still no: two
    // efforts, and the trace does not say which one the row was.
    expect(
      detectedWorkoutEnd({
        ...BASE,
        samples: minutes(restThenBackAtIt(), 65, 105, 55),
        startedAt: at(0),
        lastSetAt: null,
      })
    ).toBeNull();
  });

  it("says nothing when minutes inside the session are unmeasured", () => {
    // A wrist off mid-session is ABSENCE, so the elevated block after it cannot be shown
    // to be the same effort — "coverage is not recovery" read BETWEEN two blocks rather
    // than inside one. Without it a confident answer spans minutes nobody recorded.
    const out: ExertionSample[] = [];
    minutes(out, 0, 30, 120);
    minutes(out, 30 + EXERTION_MAX_GAP_MIN + 1, 70, 120);
    minutes(out, 70, 110, 55);
    expect(
      detectedWorkoutEnd({
        ...BASE,
        samples: out,
        startedAt: at(0),
        lastSetAt: null,
      })
    ).toBeNull();
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

  // A DROPPED TRANSITION MINUTE IS NOT A SHORTER REST (#5212 fifth pass). The rest
  // between two efforts begins when the elevation stops; measured from the first quiet
  // SAMPLE instead, one unmeasured minute — the ordinary case the gap bound forgives —
  // shortened a rest equal to this person's own recovery into one that was not, the two
  // efforts read as one, and the answer walked onto the SECOND effort's end (+40 here).
  // Every fixture above is contiguous by construction, which is why none could reach it.
  /** Two efforts resting EXACTLY the no-history recovery apart: 0–19, 30–39. */
  function twoEffortsRestingTheRecovery(
    dropTransition: boolean
  ): ExertionSample[] {
    const out: ExertionSample[] = [];
    minutes(out, 0, 20, 120);
    minutes(out, dropTransition ? 21 : 20, 30, 55);
    minutes(out, 30, 40, 120);
    minutes(out, 40, 56, 55);
    return out;
  }
  /** `count` one-minute efforts, each followed by an unmeasured minute and nine quiet. */
  function manyEffortsEachDroppingAMinute(count: number): ExertionSample[] {
    const out: ExertionSample[] = [];
    for (let i = 0; i < count; i++) {
      minutes(out, i * 11, i * 11 + 1, 120);
      minutes(out, i * 11 + 2, i * 11 + 11, 55);
    }
    return minutes(out, count * 11, count * 11 + 10, 55);
  }
  it.each([
    ["contiguous", twoEffortsRestingTheRecovery(false)],
    [
      "with the transition minute unmeasured",
      twoEffortsRestingTheRecovery(true),
    ],
    [
      "fifty-one times over, each dropping its transition minute",
      manyEffortsEachDroppingAMinute(51),
    ],
  ])("refuses two efforts resting the recovery apart, %s", (_, samples) => {
    expect(
      detectedWorkoutEnd({
        ...BASE,
        usualRecoveryMin: null,
        samples,
        startedAt: at(0),
        lastSetAt: null,
      })
    ).toBeNull();
  });
});
