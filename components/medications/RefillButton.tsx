"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconPackage } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { refillMedication } from "@/app/(app)/medications/actions";

// One-tap "Refilled" (issue #852 item 3), shown on a low-supply medication row / detail.
// It adds the LAST fill size back to the on-hand supply through the CAS write core
// (refillSupply → resolveRefillWrite), so a concurrent dose confirm isn't clobbered.
// First use (nothing remembered) reveals a small "how many units?" input; afterward it's
// a genuine one-tap that reuses the remembered size. The server still remembers whatever
// size is submitted, so the input pre-fills with it next time.
export default function RefillButton({
  itemId,
  hasLastFill,
  lastFillSize = null,
}: {
  itemId: number;
  // Whether a fill size is remembered — true ⇒ one-tap; false ⇒ ask on first tap.
  hasLastFill: boolean;
  lastFillSize?: number | null;
}) {
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [size, setSize] = useState(
    lastFillSize != null ? String(lastFillSize) : ""
  );
  const router = useRouter();
  const toast = useToast();

  async function submit(fillSize?: string) {
    if (busy) return;
    setBusy(true);
    const fd = new FormData();
    fd.set("id", String(itemId));
    if (fillSize) fd.set("fill_size", fillSize);
    try {
      const res = await refillMedication(fd);
      if (res.ok) {
        toast("Refill recorded.");
        setAsking(false);
        router.refresh();
      } else {
        toast(res.error, { tone: "error" });
      }
    } catch {
      toast("Couldn't record that refill. Try again.", {
        tone: "error",
      });
    } finally {
      setBusy(false);
    }
  }

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
      {asking && (
        <span className="inline-flex items-center gap-1">
          <input
            type="number"
            min="1"
            step="any"
            inputMode="decimal"
            value={size}
            onChange={(e) => setSize(e.target.value)}
            placeholder="units"
            aria-label="Fill size (units)"
            data-testid="refill-size"
            className="w-16 rounded-md border border-black/10 bg-transparent px-2 py-1 text-xs dark:border-white/10"
          />
          <button
            type="button"
            data-testid="refill-confirm"
            disabled={busy || !size}
            onClick={() => size && submit(size)}
            className="rounded-full border border-emerald-600 px-2.5 py-1 text-xs font-medium text-emerald-700 transition hover:bg-emerald-50 disabled:opacity-40 dark:text-emerald-300 dark:hover:bg-emerald-950"
          >
            Add
          </button>
        </span>
      )}
    </span>
  );
}
