// The school-return "fever-free 24h without meds" countdown — PURE computation +
// formatter (issue #859 item 2). No DB/network, so it's unit-tested in lib/__tests__
// and shared by EVERY surface (episode page, dashboard illness Now group, household line)
// via the one gather in lib/school-return-data.ts — the one-question-one-computation
// discipline (#221).
//
// LIABILITY POSTURE (the #798/#805 "cite, never generate" pattern): this states the
// COMMON SCHOOL/DAYCARE CONVENTION and the person's OWN logged facts (last fever
// reading, last fever-reducer). It is INFORMATIONAL, cites the convention, and never
// tells anyone what to do. The threshold is configurable per profile (default 24h);
// the convention is that a child may return once fever-free for that long WITHOUT a
// fever reducer — so BOTH clocks (the measured fever-free clock AND time since the
// last antipyretic administration) must clear the threshold. Taking a fever reducer
// masks fever, so it resets the clock exactly like a fresh fever reading — and a
// reducer that states no time when it was given resets it to an unknown instant, so the
// countdown is HELD rather than computed (#5688).
//
// AND THE CLOCK REQUIRES EVIDENCE (#4685). It starts at the first NORMAL reading
// after the last fever-range one, never at the fever itself: an unmeasured night is
// not a fever-free night, and the surface that says so is stating a fact nobody
// logged — the one thing the posture above forbids.

import type { TemperatureUnit } from "./settings";
import { fmtTemp } from "./units";

export interface SchoolReturnInputs {
  // Epoch ms of the most-recent FEVER-RANGE (flag "high") temperature reading in the
  // episode. The countdown only exists once there has been a fever, so this is never
  // null at the compute boundary (the gather returns null instead).
  lastFeverAtMs: number;
  lastFeverDegF: number;
  // Epoch ms of the FIRST NORMAL (non-fever-flag) reading after that fever reading,
  // or null when nobody has taken one since. This is the clock's EVIDENCE (#4685):
  // without it there is no fever-free claim to make, because elapsed wall time cannot
  // tell "measured normal for 13h" apart from "nobody measured for 13h".
  firstNormalAfterFeverAtMs: number | null;
  // The most-recent ANTIPYRETIC administration in the episode, or null when none was
  // taken. See `LastAntipyretic`.
  lastAntipyretic: LastAntipyretic | null;
  nowMs: number;
  thresholdHours: number;
}

// THE LAST FEVER REDUCER, AND WHETHER IT SAYS WHEN IT WAS GIVEN (#5688).
//
// A dose that STATES an administration time carries its instant, resets the clock, and
// is annotated with a bare clock. A dose that states none carries NO instant at all:
// the gather's only other timestamp is the row's filing stamp, and the school-return
// clock never computes from one (owner ruling, #5688).
//
// THE ABSENCE IS AN ARM, NOT A NULL. A `lastAntipyreticAtMs: number | null` let an
// unstated dose read as "no fever reducer was taken", which is the permissive reading
// this change exists to remove — so the unstated arm keeps the dose (name and its
// provenance-marked clock label) and simply has no `atMs` for the arithmetic to reach.
export type LastAntipyretic =
  | { timeStated: true; atMs: number; name: string; clockLabel: string | null }
  | { timeStated: false; name: string; clockLabel: string | null };

interface SchoolReturnFacts {
  thresholdHours: number;
  lastFeverDegF: number;
  // Whole hours since the last fever-range reading (floored, never negative).
  hoursSinceFever: number;
  // Whole hours since the last antipyretic — null when none was taken AND null when
  // the one that was states no administration time, since there is then nothing to
  // count from (#5688). `lastAntipyreticName` is what tells those two apart.
  hoursSinceAntipyretic: number | null;
  lastAntipyreticName: string | null;
  lastAntipyreticClockLabel: string | null;
}

// THE CLOCK IS A UNION, NOT A NUMBER PLUS A GUARD (#4685/#4458). The countdown used
// to start at the last FEVER reading and count elapsed wall time, so an unmeasured
// night accrued fever-free hours at the same rate as a measured recovery and `met`
// flipped true on silence. The evidence arm carries the number; the silent arm cannot
// represent one, so no formatter and no caller can render a fever-free claim nobody
// measured — `met: false` is the TYPE there, not a check somebody remembered.
//
// THE THIRD ARM IS A HELD CLOCK (#5688), not a shorter one. When the last fever
// reducer states no administration time there is no instant to reset from, and the
// alternatives — counting from the filing stamp, or dropping the dose — are both
// PERMISSIVE: the first starts the clock at a moment the dose may well postdate, the
// second hands the clock to an earlier dose or to none. So the countdown is held, and
// `held` borrows `none`'s shape for the same reason `none` has it: with no number to
// carry, no formatter and no caller can render a clearance out of it.
//
// THE HOLD HAS NO EXPIRY, and the gather (lib/school-return-data.ts) is where that is
// argued: one unstated dose holds this countdown for the rest of the illness, until an
// administration time is stated through the Dose history door the clause names. Every
// bound tried for it turned out to be an instant nobody logged.
export type SchoolReturnStatus = SchoolReturnFacts &
  (
    | { evidence: "none"; clearedForHours: null; met: false }
    | { evidence: "held"; clearedForHours: null; met: false }
    | { evidence: "measured"; clearedForHours: number; met: boolean }
  );

const HOUR_MS = 3_600_000;

// Whole hours between two epoch-ms instants, floored and clamped at 0 (a
// clock-skewed future reading reads as 0h, never negative).
function hoursBetween(fromMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - fromMs) / HOUR_MS));
}

// Compute the school-return countdown from the logged clocks. Pure.
export function computeSchoolReturn(
  inputs: SchoolReturnInputs
): SchoolReturnStatus {
  const last = inputs.lastAntipyretic;
  const facts: SchoolReturnFacts = {
    thresholdHours: inputs.thresholdHours,
    lastFeverDegF: inputs.lastFeverDegF,
    hoursSinceFever: hoursBetween(inputs.lastFeverAtMs, inputs.nowMs),
    // Elapsed hours only where an administration time was stated. The dose itself
    // stays in `lastAntipyreticName` either way, so a null here is "no hours can be
    // counted", never "no fever reducer was taken".
    hoursSinceAntipyretic: last?.timeStated
      ? hoursBetween(last.atMs, inputs.nowMs)
      : null,
    lastAntipyreticName: last?.name ?? null,
    lastAntipyreticClockLabel: last?.clockLabel ?? null,
  };
  // NOTHING MEASURED SINCE THE FEVER comes first, and stays first even when the last
  // reducer is unstated: "nobody has taken a temperature" is the more basic answer to
  // why there is no countdown, and it is the arm that case has always rendered.
  if (inputs.firstNormalAfterFeverAtMs == null) {
    return { ...facts, evidence: "none", clearedForHours: null, met: false };
  }
  if (last != null && !last.timeStated) {
    return { ...facts, evidence: "held", clearedForHours: null, met: false };
  }
  // The clock starts at the MEASURED normal reading and resets on the LATER of that
  // and a fever reducer (max instant = min elapsed) — a reducer masks fever, so it
  // resets the clock exactly as a fresh fever reading would.
  const clearedFromMs =
    last != null
      ? Math.max(inputs.firstNormalAfterFeverAtMs, last.atMs)
      : inputs.firstNormalAfterFeverAtMs;
  const clearedForHours = hoursBetween(clearedFromMs, inputs.nowMs);
  return {
    ...facts,
    evidence: "measured",
    clearedForHours,
    met: clearedForHours >= inputs.thresholdHours,
  };
}

// THE HELD CLAUSE, AND THE DOOR OUT OF IT (#5688, and #4686's ruling 1 for the redose
// clock — the same absence, named the same way on both clocks). It says which clock is
// held and the ONE place that releases it, which is the Dose history section where an
// administration time is added. It quotes NO time: the row states none, and inventing
// a plausible one is the single thing this document must never do (#2228 decision 4).
//
// Lower-case leading, like every other clause here, so `schoolReturnCompactLabel` can
// sentence-case it for the chip surfaces.
function heldClause(status: SchoolReturnStatus): string {
  const dose = status.lastAntipyreticName?.toLowerCase() ?? "dose";
  return `fever-free clock held — add the ${dose} time in Dose history`;
}

// The one-line countdown every surface renders (episode page, illness Now cockpit,
// household line). With a measured normal reading it leads with the fever-free hours +
// last reading, annotates the last fever reducer when one was taken, and states the
// convention + threshold. WITHOUT one it says so instead: "No reading since 103.4 °F
// (14h ago)" — the person's own logged facts, and never a fact nobody logged. With the
// last fever reducer stating no administration time it renders the HELD clause instead
// of a countdown (#5688).
// `tempUnit` renders the reading in the viewer's preference (storage is canonical °F).
// Neutral, informational — never an instruction.
export function formatSchoolReturnLine(
  status: SchoolReturnStatus,
  tempUnit: TemperatureUnit = "F"
): string {
  const reading = fmtTemp(status.lastFeverDegF, tempUnit);
  const convention =
    `the common school/daycare guideline is fever-free for ` +
    `${status.thresholdHours}h without a fever reducer.`;
  if (status.evidence === "none") {
    return (
      `No reading since ${reading} (${status.hoursSinceFever}h ago) — ` +
      convention
    );
  }
  if (status.evidence === "held") {
    // Room here for the dose's own provenance-marked clock ("recorded 6:00am"), which
    // identifies WHICH dose without claiming it as the time it was given.
    const filed = status.lastAntipyreticClockLabel
      ? ` (${status.lastAntipyreticClockLabel})`
      : "";
    const clause = heldClause(status);
    return (
      `${clause.charAt(0).toUpperCase()}${clause.slice(1)}${filed} — ` +
      convention
    );
  }
  const parts = [`last reading ${reading}`];
  if (
    status.lastAntipyreticName &&
    status.lastAntipyreticClockLabel &&
    status.hoursSinceAntipyretic != null
  ) {
    parts.push(
      `last ${status.lastAntipyreticName.toLowerCase()} ${status.lastAntipyreticClockLabel}`
    );
  }
  return (
    `Fever-free ${status.clearedForHours}h (${parts.join(" · ")}) — ` +
    convention
  );
}

// A COMPACT clause for the cross-profile household line, where the full sentence is
// too long: "fever-free 18h of 24", "no reading since 103.4 °F (14h ago)" when nothing
// has been measured since the fever (#4685), or the held clause when the last fever
// reducer states no administration time (#5688). Uses the cleared clock (the
// convention's single number) in the arm that has one. The "18h of 24" spelling is
// #4752 §1's board (#5487 fix 4), and this one formatter is why the household line,
// the episode hero and the cockpit ring all say it that way.
export function schoolReturnCompactClause(
  status: SchoolReturnStatus,
  tempUnit: TemperatureUnit = "F"
): string {
  return status.evidence === "none"
    ? `no reading since ${fmtTemp(status.lastFeverDegF, tempUnit)} ` +
        `(${status.hoursSinceFever}h ago)`
    : status.evidence === "held"
      ? heldClause(status)
      : `fever-free ${status.clearedForHours}h of ${status.thresholdHours}`;
}

// The same clause as a standalone LABEL (the cockpit chip, the episode hero), sentence
// -cased. Two pages spelled this as `.replace(/^fever-free/, "Fever-free")`, which
// silently stopped capitalizing the moment the clause could start with another word.
export function schoolReturnCompactLabel(
  status: SchoolReturnStatus,
  tempUnit: TemperatureUnit = "F"
): string {
  const clause = schoolReturnCompactClause(status, tempUnit);
  return clause.charAt(0).toUpperCase() + clause.slice(1);
}
