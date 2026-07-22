"use client";

import { MOOD_FACES, MOOD_LABELS } from "@/lib/mood";

// Shared 1–5 mood picker used by today's dashboard check-in and historical edits.
// Keeping the tap targets here means labels, selected styling, and accessibility
// cannot drift between the two write surfaces.
export default function MoodValencePicker({
  value,
  onChange,
  disabled = false,
  testIdPrefix = "mood-tap",
}: {
  value: number | null;
  onChange: (value: number) => void;
  disabled?: boolean;
  testIdPrefix?: string;
}) {
  return (
    <div className="flex items-center gap-1" role="group" aria-label="Mood">
      {MOOD_FACES.map((face, index) => {
        const score = index + 1;
        const selected = value === score;
        return (
          <button
            key={score}
            type="button"
            data-testid={`${testIdPrefix}-${score}`}
            aria-pressed={selected}
            aria-label={`Mood: ${MOOD_LABELS[index]}`}
            title={MOOD_LABELS[index]}
            disabled={disabled}
            onClick={() => onChange(score)}
            className={`flex h-9 w-9 items-center justify-center rounded-full border text-lg transition ${
              selected
                ? "border-brand-500 bg-brand-50 dark:bg-brand-950"
                : "border-transparent opacity-60 hover:opacity-100"
            } disabled:opacity-40`}
          >
            {face}
          </button>
        );
      })}
    </div>
  );
}
