// The school-return "fever-free 24h without meds" countdown — PURE computation +
// formatter (issue #859 item 2). No DB/network, so it's unit-tested in lib/__tests__
// and shared by EVERY surface (episode page, dashboard illness hero, household line)
// via the one gather in lib/school-return-data.ts — the one-question-one-computation
// discipline (#221).
//
// LIABILITY POSTURE (the #798/#805 "cite, never generate" pattern): this states the
// COMMON SCHOOL/DAYCARE CONVENTION and the person's OWN logged facts (last fever
// reading, last fever-reducer). It is INFORMATIONAL, cites the convention, and never
// tells anyone what to do. The threshold is configurable per profile (default 24h);
// the convention is that a child may return once fever-free for that long WITHOUT a
// fever reducer — so BOTH clocks (time since the last fever-range reading AND time
// since the last antipyretic administration) must clear the threshold. Taking a fever
// reducer masks fever, so it resets the clock exactly like a fresh fever reading.

import type { TemperatureUnit } from "./settings";
import { fmtTemp } from "./units";

export interface SchoolReturnInputs {
  // Epoch ms of the most-recent FEVER-RANGE (flag "high") temperature reading in the
  // episode. The countdown only exists once there has been a fever, so this is never
  // null at the compute boundary (the gather returns null instead).
  lastFeverAtMs: number;
  lastFeverDegF: number;
  // Epoch ms of the most-recent ANTIPYRETIC administration in the episode, or null
  // when none was taken. Its display name + clock label ride along for the annotation.
  lastAntipyreticAtMs: number | null;
  lastAntipyreticName: string | null;
  lastAntipyreticClockLabel: string | null;
  nowMs: number;
  thresholdHours: number;
}

export interface SchoolReturnStatus {
  thresholdHours: number;
  // Whole hours since the last fever-range reading (floored, never negative).
  feverFreeHours: number;
  lastFeverDegF: number;
  // Whole hours since the last antipyretic, or null when none was taken.
  hoursSinceAntipyretic: number | null;
  lastAntipyreticName: string | null;
  lastAntipyreticClockLabel: string | null;
  // Hours since the LATER of the two clocks — the convention's single clock, since a
  // fever reducer resets it exactly like a fresh fever reading.
  clearedForHours: number;
  // Whether the cleared clock has reached the threshold (informational only).
  met: boolean;
}

const HOUR_MS = 3_600_000;

// Whole hours between two epoch-ms instants, floored and clamped at 0 (a
// clock-skewed future reading reads as 0h, never negative).
function hoursBetween(fromMs: number, nowMs: number): number {
  return Math.max(0, Math.floor((nowMs - fromMs) / HOUR_MS));
}

// Compute the school-return countdown from the two logged clocks. Pure.
export function computeSchoolReturn(
  inputs: SchoolReturnInputs
): SchoolReturnStatus {
  const feverFreeHours = hoursBetween(inputs.lastFeverAtMs, inputs.nowMs);
  const hoursSinceAntipyretic =
    inputs.lastAntipyreticAtMs != null
      ? hoursBetween(inputs.lastAntipyreticAtMs, inputs.nowMs)
      : null;
  // The clock resets on the LATER of the two events (max instant = min elapsed).
  const clearedFromMs =
    inputs.lastAntipyreticAtMs != null
      ? Math.max(inputs.lastFeverAtMs, inputs.lastAntipyreticAtMs)
      : inputs.lastFeverAtMs;
  const clearedForHours = hoursBetween(clearedFromMs, inputs.nowMs);
  return {
    thresholdHours: inputs.thresholdHours,
    feverFreeHours,
    lastFeverDegF: inputs.lastFeverDegF,
    hoursSinceAntipyretic,
    lastAntipyreticName: inputs.lastAntipyreticName,
    lastAntipyreticClockLabel: inputs.lastAntipyreticClockLabel,
    clearedForHours,
    met: clearedForHours >= inputs.thresholdHours,
  };
}

// The one-line countdown every surface renders (episode page, hero cockpit,
// household line). Leads with the fever-free hours + last reading, annotates the last
// fever reducer when one was taken, and states the convention + threshold. `tempUnit`
// renders the reading in the viewer's preference (storage is canonical °F). Neutral,
// informational — never an instruction.
export function formatSchoolReturnLine(
  status: SchoolReturnStatus,
  tempUnit: TemperatureUnit = "F"
): string {
  const reading = fmtTemp(status.lastFeverDegF, tempUnit);
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
  const annotation = parts.join(" · ");
  return (
    `Fever-free ${status.feverFreeHours}h (${annotation}) — the common ` +
    `school/daycare guideline is fever-free for ${status.thresholdHours}h ` +
    `without a fever reducer. Informational, not medical advice.`
  );
}

// A COMPACT clause for the cross-profile household line, where the full sentence is
// too long: "fever-free 18h/24h". Null when the whole status is absent (handled by
// the caller). Uses the cleared clock (the convention's single number).
export function schoolReturnCompactClause(status: SchoolReturnStatus): string {
  return `fever-free ${status.clearedForHours}h/${status.thresholdHours}h`;
}
