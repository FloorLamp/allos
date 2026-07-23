"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import {
  MAX_WEEKLY_CAP,
  substanceDef,
  type Substance,
} from "@/lib/substance-use";
import {
  logSubstanceUnitAction,
  undoSubstanceUnitAction,
  setSubstanceTargetAction,
  clearSubstanceTargetAction,
} from "./actions";

// The per-substance consumption log + reduction-target controls (#998; #1078
// generalized beyond alcohol). One tap = one unit into the substance's OWN ledger
// (alcohol → the SAME food_log Nutrition's one-tap bar writes; nicotine/cannabis
// → substance_log) — the dispatch lives in the shared actions, so this component
// is one formatter over one write path. The target is a weekly CAP on the
// existing frequency_targets machinery; progress is the server-rendered
// capProgressLine on the page. DELIBERATELY calm: no streaks, no celebration —
// silence is the success state.

export default function ConsumptionSection({
  substance,
  weekCount,
  capSet,
  cap,
}: {
  substance: Substance;
  weekCount: number;
  capSet: boolean;
  cap: number | null;
}) {
  const router = useRouter();
  const def = substanceDef(substance);
  const [pending, setPending] = useState(false);
  const [capInput, setCapInput] = useState(cap != null ? String(cap) : "");
  const [error, setError] = useState<string | null>(null);

  async function run(fn: () => Promise<{ ok: boolean }>) {
    setError(null);
    setPending(true);
    const r = await fn();
    setPending(false);
    if (!r.ok && "error" in r) setError((r as { error: string }).error);
    router.refresh();
  }

  function withSubstance(extra?: Record<string, string>): FormData {
    const fd = new FormData();
    fd.set("substance", substance);
    for (const [k, v] of Object.entries(extra ?? {})) fd.set(k, v);
    return fd;
  }

  return (
    <div className="space-y-4">
      {/* One-tap unit log */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => logSubstanceUnitAction(withSubstance()))}
          data-testid={`substance-log-${substance}`}
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          {def.logLabel}
        </button>
        <button
          type="button"
          disabled={pending || weekCount === 0}
          onClick={() => run(() => undoSubstanceUnitAction(withSubstance()))}
          data-testid={`substance-undo-${substance}`}
          className="rounded-lg border border-black/10 px-3 py-2 text-sm disabled:opacity-50 dark:border-white/10"
        >
          Undo
        </button>
      </div>

      {/* Weekly-cap target */}
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(() =>
            setSubstanceTargetAction(withSubstance({ cap: capInput }))
          );
        }}
      >
        <label className="block text-sm">
          <span className="text-slate-500 dark:text-slate-400">
            Weekly cap ({def.countPlural}, 0–{MAX_WEEKLY_CAP}; 0 ={" "}
            {def.freeWeekPhrase})
          </span>
          <input
            type="number"
            min={0}
            max={MAX_WEEKLY_CAP}
            value={capInput}
            onChange={(e) => setCapInput(e.target.value)}
            data-testid={`substance-cap-input-${substance}`}
            className="mt-1 block w-28 rounded-lg border border-black/10 px-2 py-1 dark:border-white/10 dark:bg-slate-900"
          />
        </label>
        <button
          type="submit"
          disabled={pending || capInput === ""}
          data-testid={`substance-cap-save-${substance}`}
          className="rounded-lg border border-brand-500 px-3 py-1.5 text-sm text-brand-700 disabled:opacity-50 dark:text-brand-300"
        >
          {capSet ? "Update target" : "Set target"}
        </button>
        {capSet ? (
          <button
            type="button"
            disabled={pending}
            data-testid={`substance-cap-clear-${substance}`}
            onClick={() =>
              run(() => clearSubstanceTargetAction(withSubstance()))
            }
            className="rounded-lg border border-black/10 px-3 py-1.5 text-sm text-slate-500 disabled:opacity-50 dark:border-white/10 dark:text-slate-400"
          >
            Remove target
          </button>
        ) : null}
      </form>

      {error ? (
        <p className="text-sm text-rose-600 dark:text-rose-400">{error}</p>
      ) : null}
    </div>
  );
}
