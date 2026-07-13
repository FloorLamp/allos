"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { IconCheck, IconPlayerTrackNext } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import { setDoseStatus } from "@/app/(app)/medicine/actions";
import { localDate, shouldQueueOffline } from "@/lib/offline/queue";

// Tri-state dose check-off (issue #232): one dose is taken, deliberately skipped,
// or clear. Shared by MedicationCard and EditableSupplementRow so BOTH surfaces
// (and every viewport) get the same control — a ✅ take toggle and a ⏭ skip
// toggle, each flipping its state back to clear when pressed again.
//
// Online every transition calls the setDoseStatus Server Action with an explicit
// target, which keeps on-hand supply in lock-step (only crossing the taken
// boundary moves it). Offline mirrors DoseToggleButton's contract: from CLEAR you
// can queue a take ("dose") or a skip ("skip-dose") — both idempotent set-to
// intents the replay route applies once — but CHANGING an already-resolved dose
// needs a connection (the queue models resolutions, not un-resolving), so it's
// refused with a hint rather than silently dropped.
export type DoseVariant = "circle" | "pill";

export default function DoseStatusControl({
  doseId,
  taken,
  skipped,
  variant,
  label,
}: {
  doseId: number;
  taken: boolean;
  skipped: boolean;
  variant: DoseVariant;
  label?: string;
}) {
  // null = follow the server-provided props; a value = optimistic override held
  // after an offline queue (there's no revalidate to refresh it).
  const [optimistic, setOptimistic] = useState<
    "taken" | "skipped" | "clear" | null
  >(null);
  const [busy, setBusy] = useState(false);
  const state = optimistic ?? (taken ? "taken" : skipped ? "skipped" : "clear");
  const isTaken = state === "taken";
  const isSkipped = state === "skipped";
  const router = useRouter();
  const toast = useToast();
  const { enqueue } = useOfflineQueue();

  async function queue(kind: "dose" | "skip-dose", next: "taken" | "skipped") {
    setOptimistic(next);
    await enqueue(kind, localDate(), { doseId });
    toast(
      next === "taken"
        ? "Dose saved offline — will sync when you reconnect."
        : "Skip saved offline — will sync when you reconnect."
    );
  }

  async function apply(target: "taken" | "skipped" | "clear") {
    if (busy) return;
    const online =
      typeof navigator === "undefined" || navigator.onLine !== false;

    if (!online) {
      // Offline: only a fresh take/skip from a clear dose is queueable. Anything
      // that changes an already-resolved dose (including clearing) needs a live
      // connection.
      if (state !== "clear" || target === "clear") {
        toast("You're offline — reconnect to change a logged dose.", {
          tone: "error",
        });
        return;
      }
      await queue(target === "taken" ? "dose" : "skip-dose", target);
      return;
    }

    setBusy(true);
    const fd = new FormData();
    fd.set("dose_id", String(doseId));
    fd.set("status", target);
    try {
      await setDoseStatus(fd);
      setOptimistic(null);
      router.refresh();
    } catch (err) {
      const stillOnline = navigator.onLine !== false;
      // A dropped connection mid-submit: queue a fresh take/skip; otherwise
      // surface a retry.
      if (
        state === "clear" &&
        target !== "clear" &&
        shouldQueueOffline(stillOnline, err)
      ) {
        await queue(target === "taken" ? "dose" : "skip-dose", target);
      } else {
        toast("Couldn't update this dose. Please try again.", {
          tone: "error",
        });
      }
    } finally {
      setBusy(false);
    }
  }

  const takeClass =
    variant === "circle"
      ? `flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 text-sm transition ${
          isTaken
            ? "border-brand-600 bg-brand-600 text-white"
            : "border-black/10 text-transparent hover:border-brand-400 dark:border-white/10"
        }`
      : `flex items-center gap-2 rounded-full border px-3 py-1 text-sm transition ${
          isTaken
            ? "border-brand-600 bg-brand-600 text-white"
            : "border-black/10 text-slate-600 hover:border-brand-400 dark:border-white/10 dark:text-slate-300"
        }`;

  const skipClass =
    variant === "circle"
      ? `flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 text-sm transition ${
          isSkipped
            ? "border-amber-500 bg-amber-500 text-white"
            : "border-black/10 text-slate-400 hover:border-amber-400 dark:border-white/10 dark:text-slate-500"
        }`
      : `flex items-center rounded-full border px-2.5 py-1 text-sm transition ${
          isSkipped
            ? "border-amber-500 bg-amber-500 text-white"
            : "border-black/10 text-slate-500 hover:border-amber-400 dark:border-white/10 dark:text-slate-400"
        }`;

  return (
    <div
      // Wider gap between the two circle targets (#644) so adjacent taps —
      // taken vs. skipped, consequential for a medication — don't collide on a
      // phone. The pill variant keeps its tighter spacing.
      className={`flex shrink-0 items-center ${
        variant === "circle" ? "gap-3" : "gap-1.5"
      }`}
      data-testid="dose-status"
      data-variant={variant}
    >
      <button
        type="button"
        onClick={() => apply(isTaken ? "clear" : "taken")}
        disabled={busy}
        className={takeClass}
        aria-pressed={isTaken}
        aria-label={isTaken ? "Mark not taken" : "Mark taken"}
        data-testid="dose-take"
      >
        <IconCheck
          className={variant === "circle" ? "h-4 w-4" : "h-3.5 w-3.5"}
          stroke={2.5}
        />
        {label ? <span>{label}</span> : null}
      </button>
      <button
        type="button"
        onClick={() => apply(isSkipped ? "clear" : "skipped")}
        disabled={busy}
        className={skipClass}
        aria-pressed={isSkipped}
        aria-label={isSkipped ? "Undo skip" : "Skip this dose"}
        title={isSkipped ? "Skipped — tap to undo" : "Skip this dose"}
        data-testid="dose-skip"
      >
        <IconPlayerTrackNext
          className={variant === "circle" ? "h-4 w-4" : "h-3.5 w-3.5"}
          stroke={2.5}
        />
      </button>
    </div>
  );
}
