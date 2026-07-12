"use client";

import { INTENSITIES } from "./model";

// The activity form's intensity selector (a 3-up toggle grid). Presentational
// only — extracted from ActivityForm so the parent stays composition (#319).
export default function IntensityPicker({
  intensity,
  onChange,
}: {
  intensity: string;
  onChange: (v: string) => void;
}) {
  return (
    <div>
      <label className="label">Intensity</label>
      <div className="grid grid-cols-3 gap-2">
        {INTENSITIES.map((opt) => {
          const active = intensity === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(active ? "" : opt.value)}
              className={`rounded-lg border px-3 py-2 text-sm font-medium transition ${
                active
                  ? opt.active
                  : `bg-white dark:bg-ink-900 ${opt.cls} hover:bg-slate-50 dark:hover:bg-ink-800`
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
