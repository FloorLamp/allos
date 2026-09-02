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
// masks fever, so it resets the clock exactly like a fresh fever reading.
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
  // Epoch ms of the most-recent ANTIPYRETIC administration in the episode, or null
  // when none was taken. Its display name + clock label ride along for the annotation.
  lastAntipyreticAtMs: number | null;
  lastAntipyreticName: string | null;
  lastAntipyreticClockLabel: string | null;
  nowMs: number;
  thresholdHours: number;
}

interface SchoolReturnFacts {
  thresholdHours: number;
  lastFeverDegF: number;
  // Whole hours since the last fever-range reading (floored, never negative).
  hoursSinceFever: number;
  // Whole hours since the last antipyretic, or null when none was taken.
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
export type SchoolReturnStatus = SchoolReturnFacts &
  (
    | { evidence: "none"; clearedForHours: null; met: false }
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
  const facts: SchoolReturnFacts = {
    thresholdHours: inputs.thresholdHours,
    lastFeverDegF: inputs.lastFeverDegF,
    hoursSinceFever: hoursBetween(inputs.lastFeverAtMs, inputs.nowMs),
    hoursSinceAntipyretic:
      inputs.lastAntipyreticAtMs != null
        ? hoursBetween(inputs.lastAntipyreticAtMs, inputs.nowMs)
        : null,
    lastAntipyreticName: inputs.lastAntipyreticName,
    lastAntipyreticClockLabel: inputs.lastAntipyreticClockLabel,
  };
  if (inputs.firstNormalAfterFeverAtMs == null) {
    return { ...facts, evidence: "none", clearedForHours: null, met: false };
  }
  // The clock starts at the MEASURED normal reading and resets on the LATER of that
  // and a fever reducer (max instant = min elapsed) — a reducer masks fever, so it
  // resets the clock exactly as a fresh fever reading would.
  const clearedFromMs =
    inputs.lastAntipyreticAtMs != null
      ? Math.max(inputs.firstNormalAfterFeverAtMs, inputs.lastAntipyreticAtMs)
      : inputs.firstNormalAfterFeverAtMs;
  const clearedForHours = hoursBetween(clearedFromMs, inputs.nowMs);
  return {
    ...facts,
    evidence: "measured",
    clearedForHours,
    met: clearedForHours >= inputs.thresholdHours,
  };
}

// The one-line countdown every surface renders (episode page, illness Now cockpit,
// household line). With a measured normal reading it leads with the fever-free hours +
// last reading, annotates the last fever reducer when one was taken, and states the
// convention + threshold. WITHOUT one it says so instead: "No reading since 103.4 °F
// (14h ago)" — the person's own logged facts, and never a fact nobody logged.
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
// too long: "fever-free 18h/24h", or "no reading since 103.4 °F (14h ago)" when
// nothing has been measured since the fever (#4685). Uses the cleared clock (the
// convention's single number) in the arm that has one.
export function schoolReturnCompactClause(
  status: SchoolReturnStatus,
  tempUnit: TemperatureUnit = "F"
): string {
  return status.evidence === "none"
    ? `no reading since ${fmtTemp(status.lastFeverDegF, tempUnit)} ` +
        `(${status.hoursSinceFever}h ago)`
    : `fever-free ${status.clearedForHours}h/${status.thresholdHours}h`;
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
