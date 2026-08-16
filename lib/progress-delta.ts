// "vs last" — what one session of a lift did, against the last time the SAME lift
// was done on the SAME implement (#2870). The record's job is to answer "am I
// progressing" without making the reader open another surface and compare two
// numbers by eye.
//
// Pure: takes two already-summarized sessions (the `ExerciseCompareSession` shape
// the Analyze comparison already builds, warm-ups excluded per #338) and returns
// what to render, or null when there is nothing honest to say.

import { kgTo, round } from "./units";
import type { WeightUnit } from "./settings";

export interface ProgressDeltaInput {
  topWeightKg: number | null;
  topReps: number | null;
  e1rmKg: number | null;
  // The athlete's own weight, when it is part of `topWeightKg` (a pull-up's load
  // IS the athlete). Absent/0 for an ordinary barbell lift.
  bodyweightBaseKg?: number;
}

export interface ProgressDelta {
  // `up` and `down` are movement; `same` is a repeat, which is information too —
  // holding a load is a fact about the session, not an absence of one.
  direction: "up" | "down" | "same";
  // Rendered text: "+5 kg", "−2 reps", "same as last".
  label: string;
  // Long form for a title attribute / screen readers.
  title: string;
}

function addedLoad(session: ProgressDeltaInput): number | null {
  if (session.topWeightKg == null) return null;
  return session.topWeightKg - (session.bodyweightBaseKg ?? 0);
}

// A weight comparison is only meaningful between two loads the same way up. Reps
// break the tie when the load is identical, because the same bar for more reps is
// the most common way a working set moves — and the most common way a top-weight
// comparison alone reports "no change" about a session that clearly progressed.
export function sessionProgressDelta(
  current: ProgressDeltaInput,
  previous: ProgressDeltaInput,
  unit: WeightUnit
): ProgressDelta | null {
  // A BODYWEIGHT lift's "load" includes the athlete, so comparing the totals
  // would report weight-loss as a strength regression: two identical pull-up
  // sessions three kilos apart on the scale would read "−3 kg". What actually
  // moved is the ADDED load, so that is what is compared, and reps break the tie
  // when nothing was added on either day (the usual pull-up progression).
  const cw = addedLoad(current);
  const pw = addedLoad(previous);
  if (cw != null && pw != null) {
    // Compare in the DISPLAY unit: a 2.5 kg step is 5.5 lb, and a reader who logs
    // in pounds should not be told "+2.5" about plates they never touched. Rounding
    // both sides first also keeps a float artifact from rendering as "+0 kg".
    const c = round(kgTo(cw, unit), 1);
    const p = round(kgTo(pw, unit), 1);
    if (c !== p) {
      const diff = round(c - p, 1);
      return {
        direction: diff > 0 ? "up" : "down",
        label: `${diff > 0 ? "+" : "−"}${Math.abs(diff)} ${unit}`,
        title: `Top set ${diff > 0 ? "up" : "down"} ${Math.abs(diff)} ${unit} vs last time`,
      };
    }
    const cr = current.topReps;
    const pr = previous.topReps;
    if (cr != null && pr != null && cr !== pr) {
      const diff = cr - pr;
      return {
        direction: diff > 0 ? "up" : "down",
        label: `${diff > 0 ? "+" : "−"}${Math.abs(diff)} ${Math.abs(diff) === 1 ? "rep" : "reps"}`,
        title: `Same top load, ${diff > 0 ? "more" : "fewer"} reps vs last time`,
      };
    }
    return {
      direction: "same",
      label: "same as last",
      title: "Same top set as last time",
    };
  }

  // No comparable load on one side or the other — a bodyweight lift, or a session
  // logged as reps only. e1RM still answers when both carry one; otherwise there is
  // nothing to compare and the row says nothing rather than inventing a baseline.
  const ce = current.e1rmKg;
  const pe = previous.e1rmKg;
  if (ce == null || pe == null) return null;
  const c = round(kgTo(ce, unit), 1);
  const p = round(kgTo(pe, unit), 1);
  if (c === p) {
    return {
      direction: "same",
      label: "same as last",
      title: "Same estimated 1RM as last time",
    };
  }
  const diff = round(c - p, 1);
  return {
    direction: diff > 0 ? "up" : "down",
    label: `${diff > 0 ? "+" : "−"}${Math.abs(diff)} ${unit} e1RM`,
    title: `Estimated 1RM ${diff > 0 ? "up" : "down"} ${Math.abs(diff)} ${unit} vs last time`,
  };
}
