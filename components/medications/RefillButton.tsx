"use client";

import { useEffect, useState } from "react";
import { IconPackage } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { useConfirm } from "@/components/ConfirmDialog";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import { refillMedication } from "@/app/(app)/medications/actions";
import {
  refillRecencyExpiryMs,
  refillRecencyLine,
  type RecentRefill,
} from "@/lib/refill-recency";
import { refillRelogMessage, shouldConfirmRelog } from "@/lib/one-tap";

// One-tap "Refilled" (issue #852 item 3), shown on a low-supply medication row / detail.
// It adds the LAST fill size back to the on-hand supply through the CAS write core
// (refillSupply → resolveRefillWrite), so a concurrent dose confirm isn't clobbered.
// First use (nothing remembered) reveals a small "how many units?" input; afterward it's
// a genuine one-tap that reuses the remembered size. The server still remembers whatever
// size is submitted, so the input pre-fills with it next time.
//
// RECENCY (#1893): a refill is ADDITIVE, so an accidental double-tap adds two bottles and
// nothing used to say "you just refilled". For a short window after a successful tap the
// affordance shows an informational "Refilled just now (+90)" line — the #798 treatment.
// It is deliberately NOT a gate: two bottles is a legitimate restock, so the button stays
// enabled throughout and the line only tells the user what the previous tap did.
//
// CADENCE (#2007): a refill is the second affordance with a real expected interval — a
// fill lasts a supply cycle, weeks — and the worst failure mode in the app (two bottles
// of stock nobody has). So on top of the shared ledger's post-success cooldown, a second
// refill inside that window ASKS, naming the previous fill and the one this tap would
// add. Still a confirm and never a block: a pharmacy that filled 180 as two bottles is a
// real pair of taps, and the dialog's default is to proceed. The question is asked from
// what THIS affordance did — no refill timestamp is persisted, so a refill from another
// session or device is answered by the ledger's cooldown alone.
export default function RefillButton({
  itemId,
  hasLastFill,
  lastFillSize = null,
  supplyCycleDays = null,
}: {
  itemId: number;
  // Whether a fill size is remembered — true ⇒ one-tap; false ⇒ ask on first tap.
  hasLastFill: boolean;
  lastFillSize?: number | null;
  // How many days a full fill of this item lasts at its consumption rate
  // (daysOfSupplyForItem over `last_fill_size`), when the surface can compute it. It
  // sizes the re-log question: a 4-day supply stops asking after a day, a 90-day
  // bottle after the fixed ceiling. Null ⇒ the shared default cycle.
  supplyCycleDays?: number | null;
}) {
  const [asking, setAsking] = useState(false);
  const [size, setSize] = useState(
    lastFillSize != null ? String(lastFillSize) : ""
  );
  // The refill THIS affordance last performed, and the instant the recency line is
  // evaluated against. `now` is advanced by exactly one timer (see below) rather than
  // ticking, since the line has only one transition: showing → gone.
  const [recent, setRecent] = useState<RecentRefill | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const toast = useToast();
  const confirm = useConfirm();
  const ledger = useOptimisticLedger("medication-refill");
  const busy = ledger.pending();

  useEffect(() => {
    const delay = refillRecencyExpiryMs(recent, now);
    if (delay == null) return;
    const t = setTimeout(() => setNow(Date.now()), delay);
    return () => clearTimeout(t);
  }, [recent, now]);

  async function submit(fillSize?: string) {
    // Inside the post-success window this is the second half of a double-tap:
    // absorbed here rather than escalated into a dialog nobody asked for.
    if (ledger.blocked()) return;
    const at = Date.now();
    if (
      recent &&
      shouldConfirmRelog({
        affordance: ledger.affordance,
        lastLoggedAtMs: recent.atMs,
        nowMs: at,
        supplyCycleDays,
      })
    ) {
      const next = fillSize
        ? Number(fillSize)
        : (lastFillSize ?? recent.fillSize);
      const ok = await confirm({
        title: "Add another refill?",
        message: refillRelogMessage(recent.fillSize, next, at - recent.atMs),
        confirmLabel: "Add refill",
      });
      if (!ok) return;
    }
    await ledger.tap({
      write: () => {
        const fd = new FormData();
        fd.set("id", String(itemId));
        if (fillSize) fd.set("fill_size", fillSize);
        return refillMedication(fd);
      },
      settle: (res) => {
        if (!res.ok) {
          toast(res.error, { tone: "error" });
          // Nothing was added, so the tap stays immediately retryable.
          return { kind: "rollback" };
        }
        toast("Refill recorded.");
        setAsking(false);
        // The core's own number, not the form's — the one-tap path reuses a remembered
        // size the client may not hold, and a pooled item's fill lands on the bottle.
        setRecent({ fillSize: res.fillSize, atMs: Date.now() });
        setNow(Date.now());
        return { kind: "keep" };
      },
      onError: () => {
        toast("Couldn't record that refill. Try again.", { tone: "error" });
        return { kind: "rollback" };
      },
    });
  }

  const recency = refillRecencyLine(recent, now);

  return (
    <span className="inline-flex flex-wrap items-center gap-1.5">
      <button
        type="button"
        data-testid="refill-button"
        disabled={busy}
        onClick={() => (hasLastFill ? submit() : setAsking((v) => !v))}
        className="inline-flex items-center gap-1 rounded-full border border-emerald-300 px-2.5 py-1 text-xs font-medium text-emerald-700 transition hover:bg-emerald-50 disabled:opacity-50 dark:border-emerald-800 dark:text-emerald-300 dark:hover:bg-emerald-950"
      >
        <IconPackage className="h-3.5 w-3.5" stroke={2} aria-hidden="true" />
        Refilled
      </button>
      {recency && (
        <span
          data-testid="refill-recency"
          className="text-xs text-slate-500 dark:text-slate-400"
        >
          {recency}
        </span>
      )}
      {asking && (
        <span className="inline-flex flex-wrap items-center gap-1.5">
          <label
            htmlFor={`refill-size-${itemId}`}
            className="text-xs font-medium text-slate-600 dark:text-slate-300"
          >
            Fill size
          </label>
          <input
            id={`refill-size-${itemId}`}
            type="number"
            min="1"
            step="any"
            inputMode="decimal"
            value={size}
            onChange={(e) => setSize(e.target.value)}
            placeholder="e.g. 90"
            aria-label="Fill size (units)"
            data-testid="refill-size"
            className="w-20 rounded-md border border-black/10 bg-transparent px-2 py-1 text-xs dark:border-white/10"
          />
          <span className="text-xs text-slate-500 dark:text-slate-400">
            units
          </span>
          <button
            type="button"
            data-testid="refill-confirm"
            disabled={busy || !size}
            onClick={() => size && submit(size)}
            className="rounded-full border border-emerald-600 px-2.5 py-1 text-xs font-medium text-emerald-700 transition hover:bg-emerald-50 disabled:opacity-40 dark:text-emerald-300 dark:hover:bg-emerald-950"
          >
            Save
          </button>
        </span>
      )}
    </span>
  );
}
