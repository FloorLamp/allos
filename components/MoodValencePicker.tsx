"use client";

import { MOOD_FACES, MOOD_LABELS } from "@/lib/mood";
import IconButton from "@/components/IconButton";

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
          <IconButton
            key={score}
            type="button"
            data-testid={`${testIdPrefix}-${score}`}
            pressed={selected}
            label={`Mood: ${MOOD_LABELS[index]}`}
            tooltip={MOOD_LABELS[index]}
            disabled={disabled}
            onClick={() => onChange(score)}
          >
            {face}
          </IconButton>
        );
      })}
    </div>
  );
}
