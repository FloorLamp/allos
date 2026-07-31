"use client";

import { useState, useTransition } from "react";
import { setMetricPrimarySource } from "./source-actions";

// The per-metric primary-source picker (issue #14): "Automatic" (default
// provider preference) or one explicit source. Saves on change via the server
// action; the page re-renders with the single-series charts re-resolved. A quiet
// "Saved" confirms the write landed (and gives the e2e a durable hook).
//
// The "Only this source" checkbox (#1642) switches the SAME choice from a
// preference to an exclusion: strict mode drops the fallback, so days the source
// didn't cover become honest gaps instead of another source's readings. It is
// meaningless without a source, so it is disabled (and unchecked) on Automatic.
export default function PrimarySourcePicker({
  metric,
  current,
  strict,
  options,
}: {
  metric: string;
  current: string; // "" = automatic
  strict: boolean;
  options: { value: string; label: string }[];
}) {
  const [isPending, startTransition] = useTransition();
  const [saved, setSaved] = useState(false);
  const [source, setSource] = useState(current);
  const [onlyThis, setOnlyThis] = useState(strict);

  const save = (nextSource: string, nextStrict: boolean) => {
    const fd = new FormData();
    fd.set("metric", metric);
    fd.set("source", nextSource);
    if (nextStrict) fd.set("strict", "1");
    setSaved(false);
    startTransition(async () => {
      await setMetricPrimarySource(fd);
      setSaved(true);
    });
  };

  return (
    <div
      className="grid w-full min-w-0 grid-cols-[auto_minmax(0,1fr)] items-center gap-x-2 gap-y-1 text-xs text-slate-500 sm:flex sm:w-auto sm:flex-wrap sm:justify-end dark:text-slate-400"
      data-testid={`primary-source-control-${metric}`}
    >
      <label className="contents sm:flex sm:items-center sm:gap-2">
        <span className="shrink-0">Primary source</span>
        <select
          name="source"
          value={source}
          disabled={isPending}
          data-testid={`primary-source-${metric}`}
          className="min-w-0 w-full rounded border border-black/10 bg-white px-2 py-1 text-xs text-slate-700 sm:w-auto sm:max-w-full dark:border-white/10 dark:bg-slate-900 dark:text-slate-200"
          onChange={(e) => {
            const next = e.currentTarget.value;
            // Automatic has no source to be strict about; drop the mode with it
            // so the stored choice and the control can never disagree.
            const nextStrict = next === "" ? false : onlyThis;
            setSource(next);
            setOnlyThis(nextStrict);
            save(next, nextStrict);
          }}
        >
          <option value="">Automatic</option>
          {options.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
      </label>
      <label
        className="col-start-2 inline-flex items-center gap-1.5 sm:col-auto"
        title="Show only this source — days it didn't cover stay empty instead of falling back"
      >
        <input
          type="checkbox"
          checked={onlyThis}
          disabled={isPending || source === ""}
          data-testid={`primary-source-strict-${metric}`}
          className="h-3.5 w-3.5 rounded border-black/20 dark:border-white/20"
          onChange={(e) => {
            const next = e.currentTarget.checked;
            setOnlyThis(next);
            save(source, next);
          }}
        />
        <span>Only this source</span>
      </label>
      {saved && !isPending && (
        <span
          className="col-start-2 text-emerald-600 sm:col-auto dark:text-emerald-400"
          data-testid={`primary-source-saved-${metric}`}
        >
          Saved
        </span>
      )}
    </div>
  );
}
