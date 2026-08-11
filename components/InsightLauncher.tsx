"use client";

import type { ReactNode } from "react";

type Tone = "emerald" | "violet";

const TONE_CLASS: Record<Tone, string> = {
  emerald:
    "text-emerald-800 hover:text-emerald-950 focus-visible:ring-emerald-500/40 dark:text-emerald-300 dark:hover:text-emerald-200",
  violet:
    "text-violet-800 hover:text-violet-950 focus-visible:ring-violet-500/40 dark:text-violet-300 dark:hover:text-violet-200",
};

const COUNT_CLASS: Record<Tone, string> = {
  emerald:
    "bg-emerald-100 text-emerald-700 dark:bg-emerald-900 dark:text-emerald-300",
  violet:
    "bg-violet-100 text-violet-700 dark:bg-violet-900 dark:text-violet-300",
};

// One right-rail launcher for secondary coaching content. Food lab suggestions
// and Supplement patterns/suggestions share this exact resting control so the
// tabs do not invent different button shapes for the same modal interaction.
export default function InsightLauncher({
  label,
  count,
  icon,
  tone,
  controls,
  testId,
  onClick,
}: {
  label: string;
  count: number;
  icon: ReactNode;
  tone: Tone;
  controls: string;
  testId: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-haspopup="dialog"
      aria-controls={controls}
      data-testid={testId}
      data-variant="insight-launcher"
      onClick={onClick}
      className={`flex w-full cursor-pointer items-center gap-2 text-left text-sm font-medium outline-hidden transition focus-visible:ring-2 ${TONE_CLASS[tone]}`}
    >
      <span className="shrink-0" aria-hidden="true">
        {icon}
      </span>
      <span>{label}</span>
      <span
        className={`ml-auto rounded-full px-1.5 text-xs tabular-nums ${COUNT_CLASS[tone]}`}
      >
        {count}
      </span>
    </button>
  );
}
