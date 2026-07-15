"use client";

// The activity form's estimated-calories field (issue #151): an editable number
// input pre-filled from the MET-based auto-estimate, with a reset-to-auto control.
// The parent gates rendering on `showEstimate`. Presentational only — extracted
// from ActivityForm so the parent stays composition (#319).
export default function EstimatedCalories({
  value,
  edited,
  autoEstimateKcal,
  onChange,
  onReset,
}: {
  value: string;
  edited: boolean;
  autoEstimateKcal: number | null;
  onChange: (v: string) => void;
  onReset: () => void;
}) {
  return (
    <div data-testid="est-calories-field">
      <label className="label" htmlFor="est-calories">
        Calories{" "}
        <span className="font-normal normal-case text-slate-500 dark:text-slate-400">
          (estimated)
        </span>
      </label>
      <div className="flex items-center gap-2">
        <input
          id="est-calories"
          data-testid="est-calories-input"
          type="number"
          inputMode="numeric"
          min={0}
          step={1}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          className="input max-w-[10rem] bg-white dark:bg-ink-900"
          placeholder="—"
        />
        <span className="text-sm text-slate-500 dark:text-slate-400">kcal</span>
        {edited && autoEstimateKcal != null && (
          <button
            type="button"
            onClick={onReset}
            className="text-xs font-medium text-brand-600 hover:underline dark:text-brand-400"
          >
            reset
          </button>
        )}
      </div>
      <p className="mt-1 text-xs text-slate-500 dark:text-slate-400">
        Estimated from activity type, intensity, duration, and your bodyweight —
        edit if you have a measured value.
      </p>
    </div>
  );
}
