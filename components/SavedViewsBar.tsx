"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { IconBookmark, IconX, IconPlus } from "@tabler/icons-react";
import {
  saveTrendView,
  deleteTrendView,
  applyTrendView,
} from "@/app/(app)/trends/actions";
import type { TrendView } from "@/lib/trend-views";

// The Trends hub's saved-views switcher. A named snapshot of
// { range + tab + compare pair + pins } per profile: apply one to flip the whole
// hub to e.g. "Lipids review" without rebuilding it. Applying redirects with the
// hub's existing ?from/to/tab/cmpA/cmpB/cmpn params (and restores the pins
// snapshot) via the applyTrendView server action; saving captures the CURRENT URL
// params (read here from useSearchParams and injected as hidden inputs) plus the
// server-side pins snapshot.
export default function SavedViewsBar({ views }: { views: TrendView[] }) {
  const params = useSearchParams();
  const [saving, setSaving] = useState(false);
  const [name, setName] = useState("");

  // The live hub params, forwarded to saveTrendView as hidden inputs so the saved
  // snapshot matches exactly what's on screen.
  const current = {
    from: params.get("from") ?? "",
    to: params.get("to") ?? "",
    tab: params.get("tab") ?? "",
    cmpA: params.get("cmpA") ?? "",
    cmpB: params.get("cmpB") ?? "",
    cmpn: params.get("cmpn") === "1" ? "1" : "",
  };

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="flex items-center gap-1 text-xs font-medium uppercase tracking-wide text-slate-400 dark:text-slate-500">
        <IconBookmark className="h-3.5 w-3.5" stroke={2} />
        Views
      </span>

      {views.map((v) => (
        <span
          key={v.name}
          className="inline-flex items-center overflow-hidden rounded-full border border-slate-200 bg-white/70 text-xs dark:border-white/10 dark:bg-ink-900/60"
        >
          <form action={applyTrendView}>
            <input type="hidden" name="name" value={v.name} />
            <button
              type="submit"
              className="px-2.5 py-1 font-medium text-slate-700 transition hover:text-brand-700 dark:text-slate-200 dark:hover:text-brand-300"
              title={`Apply “${v.name}”`}
            >
              {v.name}
            </button>
          </form>
          <form action={deleteTrendView}>
            <input type="hidden" name="name" value={v.name} />
            <button
              type="submit"
              aria-label={`Delete view ${v.name}`}
              title="Delete view"
              className="flex items-center border-l border-slate-200 px-1.5 py-1 text-slate-400 transition hover:text-rose-600 dark:border-white/10 dark:hover:text-rose-400"
            >
              <IconX className="h-3.5 w-3.5" stroke={2} />
            </button>
          </form>
        </span>
      ))}

      {saving ? (
        <form
          action={saveTrendView}
          onSubmit={() => {
            setSaving(false);
            setName("");
          }}
          className="inline-flex items-center gap-1"
        >
          <input type="hidden" name="from" value={current.from} />
          <input type="hidden" name="to" value={current.to} />
          <input type="hidden" name="tab" value={current.tab} />
          <input type="hidden" name="cmpA" value={current.cmpA} />
          <input type="hidden" name="cmpB" value={current.cmpB} />
          <input type="hidden" name="cmpn" value={current.cmpn} />
          <input
            type="text"
            name="name"
            value={name}
            onChange={(e) => setName(e.target.value)}
            autoFocus
            required
            maxLength={60}
            placeholder="View name…"
            className="input h-7 w-36 py-0 text-xs"
          />
          <button
            type="submit"
            disabled={!name.trim()}
            className="rounded-full bg-brand-600 px-2.5 py-1 text-xs font-medium text-white transition hover:bg-brand-700 disabled:opacity-40"
          >
            Save
          </button>
          <button
            type="button"
            onClick={() => {
              setSaving(false);
              setName("");
            }}
            className="px-1 text-xs text-slate-400 hover:text-slate-600 dark:hover:text-slate-200"
          >
            Cancel
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => setSaving(true)}
          className="inline-flex items-center gap-1 rounded-full border border-dashed border-slate-300 px-2.5 py-1 text-xs font-medium text-slate-500 transition hover:border-brand-400 hover:text-brand-700 dark:border-white/15 dark:text-slate-400 dark:hover:text-brand-300"
        >
          <IconPlus className="h-3.5 w-3.5" stroke={2} />
          Save current
        </button>
      )}
    </div>
  );
}
