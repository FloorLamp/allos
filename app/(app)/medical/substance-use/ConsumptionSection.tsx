"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { MAX_WEEKLY_CAP } from "@/lib/substance-use";
import {
  logDrinkAction,
  undoDrinkAction,
  setSubstanceTargetAction,
  clearSubstanceTargetAction,
} from "./actions";

// The alcohol consumption log + reduction-target controls (#998). One tap = one
// standard drink into the SAME food_log ledger Nutrition's one-tap bar writes
// (group `alcohol` — one store, two surfaces). The target is a weekly CAP on the
// existing frequency_targets machinery; progress is the server-rendered
// capProgressLine on the page. DELIBERATELY calm: no streaks, no celebration —
// silence is the success state.

export default function ConsumptionSection({
  weekCount,
  capSet,
  cap,
}: {
  weekCount: number;
  capSet: boolean;
  cap: number | null;
}) {
  const router = useRouter();
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

  return (
    <div className="space-y-4">
      {/* One-tap drink log */}
      <div className="flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={pending}
          onClick={() => run(() => logDrinkAction())}
          data-testid="substance-log-drink"
          className="rounded-lg bg-brand-600 px-4 py-2 text-sm font-medium text-white disabled:opacity-50"
        >
          Log a standard drink
        </button>
        <button
          type="button"
          disabled={pending || weekCount === 0}
          onClick={() => run(() => undoDrinkAction())}
          data-testid="substance-undo-drink"
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
          const fd = new FormData();
          fd.set("substance", "alcohol");
          fd.set("cap", capInput);
          void run(() => setSubstanceTargetAction(fd));
        }}
      >
        <label className="block text-sm">
          <span className="text-slate-500 dark:text-slate-400">
            Weekly cap (standard drinks, 0–{MAX_WEEKLY_CAP}; 0 = alcohol-free
            week)
          </span>
          <input
            type="number"
            min={0}
            max={MAX_WEEKLY_CAP}
            value={capInput}
            onChange={(e) => setCapInput(e.target.value)}
            data-testid="substance-cap-input"
            className="mt-1 block w-28 rounded-lg border border-black/10 px-2 py-1 dark:border-white/10 dark:bg-slate-900"
          />
        </label>
        <button
          type="submit"
          disabled={pending || capInput === ""}
          data-testid="substance-cap-save"
          className="rounded-lg border border-brand-500 px-3 py-1.5 text-sm text-brand-700 disabled:opacity-50 dark:text-brand-300"
        >
          {capSet ? "Update target" : "Set target"}
        </button>
        {capSet ? (
          <button
            type="button"
            disabled={pending}
            data-testid="substance-cap-clear"
            onClick={() => {
              const fd = new FormData();
              fd.set("substance", "alcohol");
              void run(() => clearSubstanceTargetAction(fd));
            }}
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
