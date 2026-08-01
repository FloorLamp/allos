"use client";

import { useState } from "react";
import { IconPlus, IconMinus } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import { shouldQueueOffline } from "@/lib/offline/queue";
import FoodGroupIcon from "@/components/FoodGroupIcon";
import {
  addProteinGrams,
  undoProteinGrams,
  type ProteinLogResult,
} from "./actions";

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
// repeat). The control renders as a peer to the food-group rows: direct gram entry
// belongs in the logging flow, while nutrient gauges remain read-only analysis.

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
  const toast = useToast();
  // Offline quick-log queue (#1596): an ADD tap with no signal queues for replay.
  const { enqueue } = useOfflineQueue();

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
    const rollback = () => setTotal((t) => Math.max(0, t - delta * grams));
    // Queue an ADD tap while offline (#1596): the captured grams + day replay
    // through the same write core on reconnect, so a post-shake log with no
    // signal never fails; the optimistic total stands in until then. UNDO stays
    // online-only — a decrement is not a capture (lib/offline/queue.ts scope
    // comment) — so an offline "−" rolls back with an honest message.
    const queueOffline = async () => {
      await enqueue("food", today, {
        entry: "protein",
        groupKey: null,
        mealSlot: null,
        grams,
      });
      toast("Saved offline — will sync when you reconnect.");
    };
    const undoNeedsConnection = () => {
      rollback();
      toast("You're offline — removing protein needs a connection.", {
        tone: "error",
      });
    };
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      if (delta === 1) await queueOffline();
      else undoNeedsConnection();
      setBusy(false);
      return;
    }
    const fd = new FormData();
    fd.set("grams", String(grams));
    fd.set("date", today);
    let res: ProteinLogResult;
    try {
      res =
        delta === 1 ? await addProteinGrams(fd) : await undoProteinGrams(fd);
    } catch (err) {
      // Connection dropped mid-tap — queue an add instead of a false failure.
      if (shouldQueueOffline(navigator.onLine !== false, err)) {
        if (delta === 1) await queueOffline();
        else undoNeedsConnection();
      } else {
        rollback();
        toast("Couldn't save that — try again.", { tone: "error" });
      }
      setBusy(false);
      return;
    }
    if (res.ok) {
      // Reconcile with the server's authoritative daily total.
      setTotal(res.grams);
    } else {
      // Roll back this tap.
      rollback();
      toast(res.error || "Couldn't save that — try again.", { tone: "error" });
    }
    setBusy(false);
  }

  return (
    <div
      data-testid="protein-quickadd"
      className="flex items-center gap-3 rounded-lg border border-black/10 bg-white px-3 py-2 dark:border-white/10 dark:bg-ink-900"
    >
      <FoodGroupIcon
        slug="__protein__"
        className="h-5 w-5 shrink-0 text-emerald-500"
      />
      <div className="min-w-0 flex-1">
        <span className="block truncate font-medium text-slate-800 dark:text-slate-100">
          Protein
        </span>
        <span
          data-testid="protein-quickadd-total"
          className="block truncate text-xs tabular-nums text-slate-500 dark:text-slate-400"
        >
          {Math.round(total)}g today
        </span>
      </div>
      <button
        type="button"
        data-testid="protein-quickadd-undo"
        aria-label="Remove protein grams"
        title="Remove protein grams"
        disabled={!canSubmit || total <= 0}
        onClick={() => apply(-1)}
        className="tap-target flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-ink-800"
      >
        <IconMinus className="h-4 w-4" stroke={2} />
      </button>
      <div className="relative w-16 shrink-0 sm:w-20">
        <input
          data-testid="protein-quickadd-input"
          type="number"
          inputMode="numeric"
          min={1}
          max={300}
          step={1}
          value={amount}
          onChange={(e) => setAmount(e.target.value)}
          placeholder="0"
          aria-label="Protein grams to add"
          className="w-full rounded-lg border border-black/10 bg-white py-1.5 pl-2 pr-5 text-center text-sm tabular-nums text-slate-800 dark:border-white/10 dark:bg-ink-900 dark:text-slate-100"
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-500 dark:text-slate-400">
          g
        </span>
      </div>
      <button
        type="button"
        data-testid="protein-quickadd-add"
        aria-label="Add protein grams"
        title="Add protein grams"
        disabled={!canSubmit}
        onClick={() => apply(1)}
        className="tap-target flex h-7 w-7 shrink-0 items-center justify-center rounded-full bg-brand-600 text-white transition hover:bg-brand-700 disabled:opacity-30"
      >
        <IconPlus className="h-4 w-4" stroke={2} />
      </button>
    </div>
  );
}
