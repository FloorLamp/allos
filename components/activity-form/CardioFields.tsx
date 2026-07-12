"use client";

import type { UnitPrefs } from "@/lib/settings";
import { round, stripNegative } from "@/lib/units";
import { formatSeconds } from "@/lib/duration";
import { blockedField, type PartEntry, type PartFault } from "./model";

// Distance + duration inputs for a cardio/sport part, with the derived average
// speed and pace. `showDist` is the parent's partNeedsDistance decision so the
// field hides for distance-less activities exactly as before. `overallDuration`
// is the session's Start/End-derived duration (#336): it fills the Duration
// placeholder and is the fallback for the speed/pace calc, so a runner who logs
// Start/End doesn't have to retype the minutes to see their pace.
export default function CardioFields({
  part,
  showDist,
  distanceUnit,
  overallDuration,
  fault,
  onDistance,
  onDurationMin,
}: {
  part: PartEntry;
  showDist: boolean;
  distanceUnit: UnitPrefs["distanceUnit"];
  overallDuration: number | null;
  fault: PartFault;
  onDistance: (v: string) => void;
  onDurationMin: (v: string) => void;
}) {
  const p = part;
  const dist = Number(p.distance);
  // The part's own Duration wins; otherwise fall back to the session clock span
  // (#336) so speed/pace show without retyping the minutes.
  const dur = Number(p.durationMin) || overallDuration || 0;
  const hasSpeed = showDist && dist > 0 && dur > 0;
  const speed = hasSpeed ? round(dist / (dur / 60), 1) : null;
  // Pace = the inverse: seconds per unit distance, shown as m:ss /km|/mi — how
  // runners think, from the same inputs as speed.
  const pace = hasSpeed ? formatSeconds(Math.round((dur * 60) / dist)) : null;
  return (
    <>
      <div className="mt-2 grid grid-cols-2 gap-2">
        {showDist && (
          <div>
            <label className="label">Distance ({distanceUnit})</label>
            <input
              type="number"
              step="0.01"
              min="0"
              inputMode="decimal"
              value={p.distance}
              onChange={(e) => onDistance(stripNegative(e.target.value))}
              className={`input bg-white dark:bg-ink-900 ${
                fault === "content" ? blockedField : ""
              }`}
            />
          </div>
        )}
        <div>
          <label className="label">Duration (min)</label>
          <input
            type="number"
            min="0"
            inputMode="numeric"
            data-testid="cardio-duration"
            value={p.durationMin}
            placeholder={
              overallDuration != null ? String(overallDuration) : undefined
            }
            onChange={(e) => onDurationMin(stripNegative(e.target.value))}
            className={`input bg-white dark:bg-ink-900 ${
              fault === "content" ? blockedField : ""
            }`}
          />
        </div>
      </div>
      {speed != null && (
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          Avg speed: {speed} {distanceUnit}/h
          {pace != null && (
            <>
              {" · "}
              Pace: {pace} /{distanceUnit}
            </>
          )}
        </p>
      )}
    </>
  );
}
