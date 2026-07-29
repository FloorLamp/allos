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
    <label
      className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-xs text-slate-500 sm:flex sm:w-auto sm:flex-wrap sm:justify-end dark:text-slate-400"
      data-testid={`primary-source-control-${metric}`}
    >
      <span className="shrink-0">Primary source</span>
      <select
        name="source"
        defaultValue={current}
        disabled={isPending}
        data-testid={`primary-source-${metric}`}
        className="min-w-0 w-full rounded border border-black/10 bg-white px-2 py-1 text-xs text-slate-700 sm:w-auto sm:max-w-full dark:border-white/10 dark:bg-slate-900 dark:text-slate-200"
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
          className="col-start-2 text-emerald-600 sm:col-auto dark:text-emerald-400"
          data-testid={`primary-source-saved-${metric}`}
        >
          Saved
        </span>
      )}
    </label>
  );
}
