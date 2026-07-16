"use client";

import { useState } from "react";
import { IconCheck, IconLayoutDashboard } from "@tabler/icons-react";

export interface OnboardingWidgetChoice {
  id: string;
  label: string;
  description: string;
}

export default function DashboardChoices({
  widgets,
  initiallyVisible,
  readOnly,
}: {
  widgets: OnboardingWidgetChoice[];
  initiallyVisible: string[];
  readOnly: boolean;
}) {
  const [visible, setVisible] = useState(() => new Set(initiallyVisible));
  const preview = widgets.filter((widget) => visible.has(widget.id));

  function toggle(id: string, checked: boolean) {
    setVisible((current) => {
      const next = new Set(current);
      if (checked) next.add(id);
      else next.delete(id);
      return next;
    });
  }

  return (
    <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_17rem]">
      <div className="grid gap-3 sm:grid-cols-2">
        {widgets.map((widget) => (
          <label
            key={widget.id}
            className="relative flex cursor-pointer items-start rounded-xl border border-black/10 p-3 pr-10 transition hover:border-brand-300 has-[:checked]:border-brand-400 has-[:checked]:bg-brand-50/60 has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-brand-400/50 dark:border-white/10 dark:hover:border-brand-500/50 dark:has-[:checked]:border-brand-500/60 dark:has-[:checked]:bg-brand-500/10"
          >
            <input
              type="checkbox"
              name="widget"
              value={widget.id}
              checked={visible.has(widget.id)}
              disabled={readOnly}
              onChange={(event) =>
                toggle(widget.id, event.currentTarget.checked)
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
            <span>
              <span className="block text-sm font-medium text-slate-800 dark:text-slate-100">
                {widget.label}
              </span>
              <span className="mt-0.5 block text-xs text-slate-500 dark:text-slate-400">
                {widget.description}
              </span>
            </span>
          </label>
        ))}
      </div>

      <aside className="rounded-xl border border-black/10 bg-slate-50 p-3 dark:border-white/10 dark:bg-ink-850">
        <div className="mb-3 flex items-center gap-2 text-sm font-semibold text-slate-700 dark:text-slate-200">
          <IconLayoutDashboard className="h-4 w-4" aria-hidden="true" />
          Dashboard preview
        </div>
        {preview.length > 0 ? (
          <div className="space-y-2" data-testid="onboarding-dashboard-preview">
            {preview.map((widget) => (
              <div
                key={widget.id}
                className="rounded-lg border border-black/5 bg-white px-3 py-2 text-xs font-medium text-slate-700 shadow-sm dark:border-white/5 dark:bg-ink-900 dark:text-slate-200"
              >
                {widget.label}
              </div>
            ))}
          </div>
        ) : (
          <p className="text-xs text-slate-500 dark:text-slate-400">
            Choose at least one dashboard card.
          </p>
        )}
      </aside>
    </div>
  );
}
