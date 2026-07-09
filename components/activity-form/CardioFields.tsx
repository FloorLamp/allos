"use client";

import type { UnitPrefs } from "@/lib/settings";
import { round, stripNegative } from "@/lib/units";
import { blockedField, type PartEntry, type PartFault } from "./model";

// Distance + duration inputs for a cardio/sport part, with the derived average
// speed. `showDist` is the parent's partNeedsDistance decision so the field
// hides for distance-less activities exactly as before.
export default function CardioFields({
  part,
  showDist,
  distanceUnit,
  fault,
  onDistance,
  onDurationMin,
}: {
  part: PartEntry;
  showDist: boolean;
  distanceUnit: UnitPrefs["distanceUnit"];
  fault: PartFault;
  onDistance: (v: string) => void;
  onDurationMin: (v: string) => void;
}) {
  const p = part;
  const dist = Number(p.distance);
  const dur = Number(p.durationMin);
  const speed =
    showDist && dist > 0 && dur > 0 ? round(dist / (dur / 60), 1) : null;
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
            value={p.durationMin}
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
        </p>
      )}
    </>
  );
}
