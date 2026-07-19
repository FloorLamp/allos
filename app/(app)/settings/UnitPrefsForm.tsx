"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { saveUnitPrefs } from "./actions";
import SaveStatus from "@/components/SaveStatus";
import { useSaveStatus } from "@/components/useSaveStatus";
import type {
  DistanceUnit,
  TemperatureUnit,
  UnitPrefs,
  WeightUnit,
} from "@/lib/settings";

// Unit display preferences — a LOGIN-scoped setting (the signed-in login's
// display choice), not a property of the active profile.
export default function UnitPrefsForm({ prefs }: { prefs: UnitPrefs }) {
  const router = useRouter();
  const [weightUnit, setWeightUnit] = useState<WeightUnit>(prefs.weightUnit);
  const [distanceUnit, setDistanceUnit] = useState<DistanceUnit>(
    prefs.distanceUnit
  );
  const [temperatureUnit, setTemperatureUnit] = useState<TemperatureUnit>(
    prefs.temperatureUnit
  );
  const { pending, savedAt, error, save: runSave } = useSaveStatus();

  function save(next: {
    weightUnit: WeightUnit;
    distanceUnit: DistanceUnit;
    temperatureUnit: TemperatureUnit;
  }) {
    const fd = new FormData();
    fd.set("weight_unit", next.weightUnit);
    fd.set("distance_unit", next.distanceUnit);
    fd.set("temperature_unit", next.temperatureUnit);
    runSave(async () => {
      await saveUnitPrefs(fd);
      router.refresh();
    });
  }

  return (
    <div className="card max-w-lg space-y-5">
      <div className="flex items-center justify-between">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Units
        </h2>
        <SaveStatus pending={pending} savedAt={savedAt} error={error} />
      </div>

      <div>
        <label className="label">Weight &amp; lifts</label>
        <select
          value={weightUnit}
          onChange={(e) => {
            const v = e.target.value as WeightUnit;
            setWeightUnit(v);
            save({ weightUnit: v, distanceUnit, temperatureUnit });
          }}
          className="input"
        >
          <option value="kg">Kilograms (kg)</option>
          <option value="lb">Pounds (lb)</option>
        </select>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Used for body weight, lifted weight, and benchmarks.
        </p>
      </div>

      <div>
        <label className="label">Distance</label>
        <select
          data-testid="distance-unit-select"
          value={distanceUnit}
          onChange={(e) => {
            const v = e.target.value as DistanceUnit;
            setDistanceUnit(v);
            save({ weightUnit, distanceUnit: v, temperatureUnit });
          }}
          className="input"
        >
          <option value="km">Kilometers (km)</option>
          <option value="mi">Miles (mi)</option>
        </select>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Used for cardio and sport distances.
        </p>
      </div>

      <div>
        <label className="label">Temperature</label>
        <select
          data-testid="temperature-unit-select"
          value={temperatureUnit}
          onChange={(e) => {
            const v = e.target.value as TemperatureUnit;
            setTemperatureUnit(v);
            save({ weightUnit, distanceUnit, temperatureUnit: v });
          }}
          className="input"
        >
          <option value="F">Fahrenheit (°F)</option>
          <option value="C">Celsius (°C)</option>
        </select>
        <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
          Used for body temperature and fever tracking.
        </p>
      </div>
    </div>
  );
}
