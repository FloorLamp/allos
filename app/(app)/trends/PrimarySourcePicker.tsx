"use client";

import { useState, useTransition } from "react";
import { setMetricPrimarySource } from "./source-actions";

// The per-metric primary-source picker (issue #14): "Automatic" (default
// provider preference) or one explicit source. Saves on change via the server
// action; the page re-renders with the single-series charts re-resolved. A quiet
// "Saved" confirms the write landed (and gives the e2e a durable hook).
export default function PrimarySourcePicker({
  metric,
  current,
  options,
}: {
  metric: string;
  current: string; // "" = automatic
  options: { value: string; label: string }[];
}) {
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  return (
    <label className="flex items-center gap-2 text-xs text-slate-500 dark:text-slate-400">
      <span>Primary source</span>
      <select
        name="source"
        defaultValue={current}
        disabled={isPending}
        data-testid={`primary-source-${metric}`}
        className="rounded border border-black/10 bg-white px-2 py-1 text-xs text-slate-700 dark:border-white/10 dark:bg-slate-900 dark:text-slate-200"
        onChange={(e) => {
          const fd = new FormData();
          fd.set("metric", metric);
          fd.set("source", e.currentTarget.value);
          setSaved(false);
          startTransition(async () => {
            await setMetricPrimarySource(fd);
            setSaved(true);
          });
        }}
      >
        <option value="">Automatic</option>
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
      {saved && !isPending && (
        <span
          className="text-emerald-600 dark:text-emerald-400"
          data-testid={`primary-source-saved-${metric}`}
        >
          Saved
        </span>
      )}
    </label>
  );
}
