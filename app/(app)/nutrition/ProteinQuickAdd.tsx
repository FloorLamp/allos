"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { IconPlus, IconMinus } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { addProteinGrams, undoProteinGrams } from "./actions";

// Protein-grams quick-add (issue #824), modeled on the one-tap food-serving bar
// (FoodLogBar): a single number control that SUMS into the day's manual-protein total.
// Protein powder / shakes have no food-group catalog home (a `protein_shake` group would
// double-count the milk/eggs), so this is the shake path — the direct-grams `logged`
// basis that adds to the food-group estimated floor on the adequacy card above.
//
// The number in the box is the delta for BOTH buttons (the FoodLogBar +/- idiom): "+"
// adds it to the day, "−" removes it. Optimistic local total, a Server Action per tap,
// reconciled to the server's authoritative total (#748 item 2) so a failed write can't
// leave a phantom gram count. The box pre-fills with the last-used amount (scoop sizes
// repeat); a preset chip re-offers it after an edit. Deliberately unobtrusive — the
// total only reads as meaningful once you've logged something.

export default function ProteinQuickAdd({
  today,
  initialGrams,
  lastPreset,
}: {
  // The acting profile's today (YYYY-MM-DD) — the quick-add logs to today only.
  today: string;
  // Today's manual-protein total so far (0 when nothing logged).
  initialGrams: number;
  // The profile's last-used amount (repeated scoop size), or null if never logged.
  lastPreset: number | null;
}) {
  const [total, setTotal] = useState(initialGrams);
  const [amount, setAmount] = useState<string>(
    lastPreset != null ? String(lastPreset) : ""
  );
  const [busy, setBusy] = useState(false);
  const [, startTransition] = useTransition();
  const router = useRouter();
  const toast = useToast();

  const grams = Number(amount);
  const canSubmit = Number.isFinite(grams) && grams > 0 && !busy;

  async function apply(delta: 1 | -1) {
    if (!(Number.isFinite(grams) && grams > 0)) {
      toast("Enter a protein amount in grams.", { tone: "error" });
      return;
    }
    setBusy(true);
    // Optimistic: reflect the change immediately (clamped at zero on remove).
    setTotal((t) => Math.max(0, t + delta * grams));
    const fd = new FormData();
    fd.set("grams", String(grams));
    fd.set("date", today);
    const res =
      delta === 1 ? await addProteinGrams(fd) : await undoProteinGrams(fd);
    if (res.ok) {
      // Reconcile with the server's authoritative daily total.
      setTotal(res.grams);
    } else {
      // Roll back this tap.
      setTotal((t) => Math.max(0, t - delta * grams));
      toast(res.error || "Couldn't save that — try again.", { tone: "error" });
    }
    setBusy(false);
    startTransition(() => router.refresh());
  }

  return (
    <div data-testid="protein-quickadd" className="card">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h2 className="font-semibold text-slate-800 dark:text-slate-100">
          Log protein
        </h2>
        <span
          data-testid="protein-quickadd-total"
          className="shrink-0 text-sm font-medium tabular-nums text-slate-500 dark:text-slate-400"
        >
          {Math.round(total)} g today
        </span>
      </div>
      <p className="mb-3 text-xs text-slate-500 dark:text-slate-400">
        A shake or protein powder has no food group — log its grams here and
        they add to your estimate above.
      </p>
      <div className="flex items-center gap-2">
        <button
          type="button"
          data-testid="protein-quickadd-undo"
          aria-label="Remove protein grams"
          disabled={!canSubmit || total <= 0}
          onClick={() => apply(-1)}
          className="tap-target flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-ink-800"
        >
          <IconMinus className="h-4 w-4" stroke={2} />
        </button>
        <div className="relative flex-1">
          <input
            data-testid="protein-quickadd-input"
            type="number"
            inputMode="numeric"
            min={1}
            max={300}
            step={1}
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
            placeholder="grams"
            aria-label="Protein grams to add"
            className="w-full rounded-lg border border-black/10 bg-white px-3 py-2 pr-8 text-sm tabular-nums text-slate-800 dark:border-white/10 dark:bg-ink-900 dark:text-slate-100"
          />
          <span className="pointer-events-none absolute right-3 top-1/2 -translate-y-1/2 text-xs text-slate-500 dark:text-slate-400">
            g
          </span>
        </div>
        <button
          type="button"
          data-testid="protein-quickadd-add"
          aria-label="Add protein grams"
          disabled={!canSubmit}
          onClick={() => apply(1)}
          className="btn btn-sm shrink-0"
        >
          <IconPlus className="h-4 w-4" stroke={2} />
          Add
        </button>
      </div>
      {lastPreset != null && (
        <div className="mt-3 flex items-center gap-2">
          <span className="text-xs text-slate-500 dark:text-slate-400">
            Last used
          </span>
          <button
            type="button"
            data-testid="protein-quickadd-preset"
            onClick={() => setAmount(String(lastPreset))}
            className="rounded-full border border-black/10 px-2.5 py-1 text-xs font-medium text-slate-600 transition hover:bg-slate-100 dark:border-white/10 dark:text-slate-300 dark:hover:bg-ink-800"
          >
            {lastPreset} g
          </button>
        </div>
      )}
    </div>
  );
}
