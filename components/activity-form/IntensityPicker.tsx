"use client";

import { INTENSITIES } from "./model";

// The activity form's intensity selector (a 3-up toggle grid). Presentational
// only — extracted from ActivityForm so the parent stays composition (#319).
export default function IntensityPicker({
  intensity,
  compact = false,
  onChange,
}: {
  intensity: string;
  compact?: boolean;
  onChange: (v: string) => void;
}) {
  const selected = INTENSITIES.find((o) => o.value === intensity);
  return (
    <fieldset>
      <legend className="label">Intensity</legend>
      <div className="grid grid-cols-3 gap-2">
        {INTENSITIES.map((opt) => {
          const active = intensity === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              title={opt.hint}
              onClick={() => onChange(active ? "" : opt.value)}
              className={`rounded-lg border px-2 py-2 text-sm font-medium transition ${
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
      {/* Explain the selected level and that it drives the calorie estimate — the
          control used to silently feed the MET tier with no descriptor (#336). */}
      <p
        className={`${compact ? "mt-0.5" : "mt-1"} text-xs text-slate-500 dark:text-slate-400`}
      >
        {selected
          ? `${selected.hint} · affects the calorie estimate`
          : "Sets effort level — affects the calorie estimate"}
      </p>
    </fieldset>
  );
}
