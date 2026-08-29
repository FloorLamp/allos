import { SYMPTOM_SEVERITY_LEVELS } from "@/lib/symptoms";

type SymptomSeverityValue = (typeof SYMPTOM_SEVERITY_LEVELS)[number]["value"];

export interface SymptomSeverityControlProps {
  symptomLabel: string;
  value: number;
  onChange: (value: SymptomSeverityValue) => void;
  testIdPrefix?: string;
}

// Symptom severity is one fixed 1–4 domain control. Both staged suggestions and
// logged symptoms use this treatment; the component derives every option's name,
// title, pressed state and cumulative fill from the shared severity vocabulary.
//
// THE OPTIONS ARE THE CONTROL BOX (#3938/#3954). They used to render 44 square,
// which is the row the owner reported: four 44px digits beside the 34px icon
// buttons that share their line. Square, so the box is spent on both axes; and
// `.tap-target` — the same mechanism under its own name — gives a coarse pointer
// the reach back, which is what the row's `gap-3` pays for.
export default function SymptomSeverityControl({
  symptomLabel,
  value,
  onChange,
  testIdPrefix,
}: SymptomSeverityControlProps) {
  return (
    <div
      role="group"
      aria-label={`${symptomLabel} severity`}
      // `gap-3` is the reach floor (#3938): the options wear the control box and
      // a coarse pointer extends each one by `--control-reach` per side, so two
      // neighbours need twice that between them or they own the same pixels.
      className="inline-flex items-center gap-3"
    >
      {SYMPTOM_SEVERITY_LEVELS.map((level) => (
        <button
          key={level.value}
          type="button"
          data-testid={
            testIdPrefix ? `${testIdPrefix}-${level.value}` : undefined
          }
          aria-pressed={value === level.value}
          aria-label={`${symptomLabel} — severity ${level.value} of ${SYMPTOM_SEVERITY_LEVELS.length} (${level.label})`}
          onClick={() => onChange(level.value)}
          className={`tap-target inline-flex h-(--control-box) w-(--control-box) shrink-0 items-center justify-center rounded text-xs font-semibold ${
            value >= level.value
              ? "bg-brand-600 text-white"
              : "bg-slate-100 text-slate-500 hover:bg-slate-200 dark:bg-ink-800 dark:text-slate-400 dark:hover:bg-ink-700"
          }`}
        >
          {level.value}
        </button>
      ))}
    </div>
  );
}
