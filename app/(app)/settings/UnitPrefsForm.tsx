"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveUnitPrefs } from "./actions";
import SaveStatus from "@/components/SaveStatus";
import type { DistanceUnit, UnitPrefs, WeightUnit } from "@/lib/settings";

// Unit display preferences — a LOGIN-scoped setting (the signed-in login's
// display choice), not a property of the active profile.
export default function UnitPrefsForm({ prefs }: { prefs: UnitPrefs }) {
  const router = useRouter();
  const [weightUnit, setWeightUnit] = useState<WeightUnit>(prefs.weightUnit);
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>(
    prefs.distanceUnit
  );
  const [pending, startTransition] = useTransition();
  const [savedAt, setSavedAt] = useState(0);

  function save(next: { weightUnit: WeightUnit; distanceUnit: DistanceUnit }) {
    const fd = new FormData();
    fd.set("weight_unit", next.weightUnit);
    fd.set("distance_unit", next.distanceUnit);
    startTransition(async () => {
      await saveUnitPrefs(fd);
      setSavedAt(Date.now());
      router.refresh();
    });
  }

  return (
    <div className="card max-w-lg space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Units
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} />
      </div>

      <div>
        <label className="label">Weight &amp; lifts</label>
        <select
          value={weightUnit}
          onChange={(e) => {
            const v = e.target.value as WeightUnit;
            setWeightUnit(v);
            save({ weightUnit: v, distanceUnit });
          }}
          className="input"
        >
          <option value="kg">Kilograms (kg)</option>
          <option value="lb">Pounds (lb)</option>
        </select>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          Used for body weight, lifted weight, and benchmarks.
        </p>
      </div>

      <div>
        <label className="label">Distance</label>
        <select
          value={distanceUnit}
          onChange={(e) => {
            const v = e.target.value as DistanceUnit;
            setDistanceUnit(v);
            save({ weightUnit, distanceUnit: v });
          }}
          className="input"
        >
          <option value="km">Kilometers (km)</option>
          <option value="mi">Miles (mi)</option>
        </select>
        <p className="mt-1 text-xs text-slate-400 dark:text-slate-500">
          Used for cardio and sport distances.
        </p>
      </div>
    </div>
  );
}
