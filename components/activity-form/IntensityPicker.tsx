"use client";

import { INTENSITIES } from "./model";
import InfoTooltipIcon from "@/components/InfoTooltipIcon";

// The activity form's intensity selector (a 3-up toggle grid). Presentational
// only — extracted from ActivityForm so the parent stays composition (#319).

// WHAT THE PICKER MEANS, STATED ONCE (#5726, #5300 rule 4). The three descriptors
// and the fact that the level feeds the calorie estimate are mechanics copy, so they
// live behind the info affordance rather than under the buttons as standing prose.
const INTENSITY_HELP = `${INTENSITIES.map(
  (option) => `${option.label}: ${option.hint}`
).join(" · ")} · Affects the calorie estimate`;

export default function IntensityPicker({
  intensity,
  onChange,
}: {
  intensity: string;
  onChange: (v: string) => void;
}) {
  return (
    <fieldset>
      {/* The glyph sits INSIDE the legend, so it reads as part of the label rather
          than stranded on its own line between the label and the buttons. `.label`
          stays a block; the affordance is inline-flex, so it flows after the word. */}
      <legend className="label">
        Intensity{" "}
        <InfoTooltipIcon label={INTENSITY_HELP} data-testid="intensity-help" />
      </legend>
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
    </fieldset>
  );
}
