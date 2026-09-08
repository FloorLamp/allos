"use client";

import { useState } from "react";
import { IconPlus, IconMinus } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { useWritePipeline } from "@/components/useWritePipeline";
import FoodGroupIcon from "@/components/FoodGroupIcon";
import RollingNumber from "@/components/RollingNumber";
import { addProteinGrams, undoProteinGrams } from "./actions";

// Direct protein grams contribute to the day's manual total. The typed amount is
// the delta for both add and remove; it is not an inverse of a stored serving.
// The pipeline owns transport, queue capture, and optimistic settlement.

export default function ProteinQuickAdd({
  today,
  initialGrams,
  lastPreset,
}: {
  // The day the bar has selected (YYYY-MM-DD) — the tap logs against this, so a
  // move of the day picker moves where a typed amount lands.
  today: string;
  // That day's manual-protein total so far (0 when nothing logged).
  initialGrams: number;
  // The profile's last-used amount (repeated scoop size), or null if never logged.
  lastPreset: number | null;
}) {
  const [total, setTotal] = useState(initialGrams);
  const [amount, setAmount] = useState<string>(
    lastPreset != null ? String(lastPreset) : ""
  );
  // Keep typed grams when the selected day changes; only its displayed total resets.
  const [seededDay, setSeededDay] = useState(today);
  if (seededDay !== today) {
    setSeededDay(today);
    setTotal(initialGrams);
  }
  const toast = useToast();
  const pipeline = useWritePipeline<"protein-grams", number>("protein-grams");

  const grams = Number(amount);
  const busy = pipeline.pending("add") || pipeline.pending("undo");
  const canSubmit = Number.isFinite(grams) && grams > 0 && !busy;

  async function apply(delta: 1 | -1) {
    if (!(Number.isFinite(grams) && grams > 0)) {
      toast("Enter a protein amount in grams.", { tone: "error" });
      return;
    }
    await pipeline.run({
      key: delta === 1 ? "add" : "undo",
      fields: { grams: String(grams), date: today },
      action: delta === 1 ? addProteinGrams : undoProteinGrams,
      optimistic: {
        key: today,
        from: total,
        to: Math.max(0, total + delta * grams),
        commit: setTotal,
      },
      settle: (res) =>
        res.ok
          ? { wrote: true, value: res.grams, announce: "silent" }
          : {
              wrote: false,
              announce: {
                message: res.error || "Couldn't save that — try again.",
                tone: "error",
                undo: null,
              },
            },
      offline: () =>
        delta === 1
          ? {
              kind: "capture",
              flow: "food",
              date: today,
              payload: {
                entry: "protein",
                groupKey: null,
                mealSlot: null,
                grams,
              },
              keptMessage: "Saved offline — will sync when you reconnect.",
            }
          : {
              kind: "refuse",
              message: "You're offline — removing protein needs a connection.",
            },
      failureMessage: "Couldn't save that — try again.",
    });
  }

  return (
    // THE PROTEIN CHIP, AT THE USUAL GRAMS (#4477's blessed add door). The scoop keeps
    // its own control — a per-tap magnitude field is not a serving stepper — but it wears
    // the same chip the ranked groups beside it do, on one line, so the ranked head reads
    // as one strip instead of a stack of full-width cards. The amount field still
    // pre-fills with the last-used scoop, which is what "at the usual grams" is.
    <div
      data-testid="protein-quickadd"
      className="inline-flex max-w-full items-center gap-1.5 rounded-full border border-(--border) bg-surface py-1 pl-2.5 pr-1"
    >
      <FoodGroupIcon
        slug="__protein__"
        className="h-4 w-4 shrink-0 text-emerald-500"
      />
      <div className="flex min-w-0 items-baseline gap-1.5">
        <span className="truncate font-medium text-slate-800 dark:text-slate-100">
          Protein
        </span>
        <span
          data-testid="protein-quickadd-total"
          className="truncate text-xs tabular-nums text-slate-500 dark:text-slate-400"
        >
          {/* The authoritative grams land immediately (#2654, motion 3); a bounded
              scale pulse acknowledges the optimistic change without delaying the
              text. Under reduced motion the new number is simply there, which is why
              an exact-text assertion on this line stays honest either way. */}
          <RollingNumber
            value={Math.round(total)}
            testId="protein-quickadd-grams"
          />
          g today
        </span>
      </div>
      {/* THE CONTROL BOX (#4505, over #3486's 32). `.tap-target`'s `inset: -6px`
          adds a fixed 12px, so 34 + 12 = 46 clears #3514's 44px floor; at `h-7`
          this pair was 40px effective while carrying the class that claims the
          floor. lib/tap-floor-tokens.ts holds the arithmetic. */}
      <button
        type="button"
        data-testid="protein-quickadd-undo"
        aria-label="Remove protein grams"
        disabled={!canSubmit || total <= 0}
        onClick={() => apply(-1)}
        className="tap-target flex h-(--control-box) w-(--control-box) shrink-0 items-center justify-center rounded-full text-slate-400 transition hover:bg-slate-100 disabled:opacity-30 dark:hover:bg-ink-800"
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
          className="w-full rounded-lg border border-(--field-bd) bg-field py-1.5 pl-2 pr-5 text-center text-sm tabular-nums text-slate-800 dark:text-slate-100"
        />
        <span className="pointer-events-none absolute right-2 top-1/2 -translate-y-1/2 text-xs text-slate-500 dark:text-slate-400">
          g
        </span>
      </div>
      <button
        type="button"
        data-testid="protein-quickadd-add"
        aria-label="Add protein grams"
        disabled={!canSubmit}
        onClick={() => apply(1)}
        className="tap-target flex h-(--control-box) w-(--control-box) shrink-0 items-center justify-center rounded-full bg-brand-600 text-white transition hover:bg-brand-700 disabled:opacity-30"
      >
        <IconPlus className="h-4 w-4" stroke={2} />
      </button>
    </div>
  );
}
