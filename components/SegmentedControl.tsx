"use client";

// Shared compact selector used when several mutually-exclusive local views fit
// on one line. Extracted from the Sleep page's 14 / 30 / 90 day range control so
// dense time selectors use the same inset track, selected surface, and
// aria-pressed semantics.

export interface SegmentedControlOption<T extends string | number> {
  value: T;
  label: string;
  disabled?: boolean;
  testId?: string;
  dataAttributes?: Record<string, string | number>;
}

export default function SegmentedControl<T extends string | number>({
  options,
  value,
  onChange,
  ariaLabel,
  testId,
  className = "",
}: {
  options: SegmentedControlOption<T>[];
  value: T;
  onChange: (value: T) => void;
  ariaLabel: string;
  testId?: string;
  className?: string;
}) {
  return (
    <div
      role="group"
      aria-label={ariaLabel}
      data-testid={testId}
      className={`inline-flex rounded-lg bg-slate-100 p-1 dark:bg-ink-800 ${className}`}
    >
      {options.map((option) => {
        const active = value === option.value;
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onChange(option.value)}
            aria-pressed={active}
            disabled={option.disabled}
            data-testid={option.testId}
            {...option.dataAttributes}
            className={`shrink-0 rounded-md px-3 py-1 text-xs font-medium whitespace-nowrap transition ${
              active
                ? "bg-white text-slate-900 shadow-xs dark:bg-ink-700 dark:text-slate-100"
                : "text-slate-500 hover:text-slate-800 disabled:cursor-not-allowed disabled:opacity-35 disabled:hover:text-slate-500 dark:text-slate-400 dark:hover:text-slate-100 dark:disabled:hover:text-slate-400"
            }`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
