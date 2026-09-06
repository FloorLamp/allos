"use client";

import { INTENSITIES } from "./model";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";

// The activity form's intensity selector (a 3-up toggle grid). Presentational
// only — extracted from ActivityForm so the parent stays composition (#319).
export default function IntensityPicker({
  intensity,
  onChange,
}: {
  intensity: string;
  onChange: (v: string) => void;
}) {
  const selected = INTENSITIES.find((o) => o.value === intensity);
  return (
    <fieldset>
      <legend className="label">Intensity</legend>
      <InfoTooltipIcon
        label={INTENSITIES.map(
          (option) => `${option.label}: ${option.hint}`
        ).join(" · ")}
      />
      {/* `gap-3` is the reach floor (#3938). */}
      <div className="grid grid-cols-3 gap-3">
        {INTENSITIES.map((opt) => {
          const active = intensity === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              aria-pressed={active}
              onClick={() => onChange(active ? "" : opt.value)}
              // ONE NEUTRAL REST, ONE BRAND SELECTION (#5376): the row states effort
              // by what is pressed, not by hue. The rest paint is bg-field + the field
              // border, matching .input, because these buttons sit among the form's
              // fields and must read as the same control surface (entry-ergonomics).
              className={`tap-target min-h-(--control-box) rounded-lg border px-2 py-1.5 text-sm font-medium transition ${
                active
                  ? "border-brand-600 bg-brand-600 text-white dark:border-brand-500 dark:bg-brand-500"
                  : "border-(--field-bd) bg-field text-slate-700 hover:bg-slate-50 dark:text-slate-200 dark:hover:bg-ink-800"
              }`}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
      {/* Explain the selected level and that it drives the calorie estimate — the
          control used to silently feed the MET tier with no descriptor (#336). */}
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        {selected
          ? `${selected.hint} · affects the calorie estimate`
          : "Sets effort level — affects the calorie estimate"}
      </p>
    </fieldset>
  );
}
