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
      className="inline-flex items-center gap-1"
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
          className={`inline-flex h-11 w-11 shrink-0 items-center justify-center rounded text-xs font-semibold ${
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
