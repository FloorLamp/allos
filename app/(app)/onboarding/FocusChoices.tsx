"use client";

import { useState } from "react";
import {
  IconBarbell,
  IconCalendarCheck,
  IconChartLine,
  IconCheck,
  IconFileText,
  IconPill,
  IconSparkles,
  IconUsers,
} from "@tabler/icons-react";
import { ONBOARDING_FOCUS_DEFS, type OnboardingFocus } from "@/lib/onboarding";

const FOCUS_ICONS: Record<OnboardingFocus, typeof IconFileText> = {
  "medical-records": IconFileText,
  medications: IconPill,
  fitness: IconBarbell,
  "metrics-labs": IconChartLine,
  "preventive-care": IconCalendarCheck,
  caregiving: IconUsers,
  explore: IconSparkles,
};

function FocusIcon({ focus }: { focus: OnboardingFocus }) {
  const Icon = FOCUS_ICONS[focus];
  return (
    <span
      data-testid="onboarding-focus-icon"
      className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-brand-50 text-brand-600 dark:bg-brand-500/10 dark:text-brand-400"
    >
      <Icon className="h-5 w-5" stroke={1.8} aria-hidden="true" />
    </span>
  );
}

export default function FocusChoices({
  selected,
  readOnly,
}: {
  selected: OnboardingFocus[];
  readOnly: boolean;
}) {
  const [choices, setChoices] = useState(() => new Set(selected));
  const atLimit = choices.size >= 2;

  function toggle(focus: OnboardingFocus, checked: boolean) {
    setChoices((current) => {
      if (checked && focus === "explore") return new Set([focus]);

      const next = new Set(current);
      if (checked) {
        next.delete("explore");
        if (next.size < 2) next.add(focus);
      } else {
        next.delete(focus);
      }
      return next;
    });
  }

  return (
    <div className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        {ONBOARDING_FOCUS_DEFS.map((focus) => {
          const checked = choices.has(focus.id);
          const disabled =
            readOnly || (!checked && focus.id !== "explore" && atLimit);
          return (
            <label
              key={focus.id}
              className="relative flex cursor-pointer items-start rounded-xl border border-black/10 p-3 pr-10 transition hover:border-brand-300 has-[:checked]:border-brand-400 has-[:checked]:bg-brand-50/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-400/50 has-[:disabled]:cursor-default has-[:disabled]:opacity-55 dark:border-white/10 dark:hover:border-brand-500/50 dark:has-[:checked]:border-brand-500/60 dark:has-[:checked]:bg-brand-500/10"
            >
              <input
                type="checkbox"
                name="focus"
                value={focus.id}
                checked={checked}
                disabled={disabled}
                onChange={(event) =>
                  toggle(focus.id, event.currentTarget.checked)
                }
                className="peer absolute top-3 right-3 h-5 w-5 cursor-pointer appearance-none rounded-md border border-slate-300 bg-white transition checked:border-brand-600 checked:bg-brand-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-brand-400/50 disabled:cursor-default dark:border-slate-600 dark:bg-ink-900 dark:checked:border-brand-500 dark:checked:bg-brand-500"
              />
              <span className="pointer-events-none absolute top-3 right-3 flex h-5 w-5 items-center justify-center text-white opacity-0 transition peer-checked:opacity-100">
                <IconCheck
                  className="h-3.5 w-3.5"
                  stroke={2.5}
                  aria-hidden="true"
                />
              </span>
              <span className="flex min-w-0 items-start gap-3">
                <FocusIcon focus={focus.id} />
                <span>
                  <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">
                    {focus.label}
                  </span>
                  <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                    {focus.description}
                  </span>
                </span>
              </span>
            </label>
          );
        })}
      </div>
      <p
        className="text-xs text-slate-400 dark:text-slate-500"
        aria-live="polite"
      >
        {choices.has("explore")
          ? "Explore everything replaces narrower priorities."
          : `${choices.size} of 2 priorities selected.`}
      </p>
    </div>
  );
}
