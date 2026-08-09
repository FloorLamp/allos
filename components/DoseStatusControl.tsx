"use client";

import { useState } from "react";
import { IconCheck, IconPlayerTrackNext } from "@tabler/icons-react";
import { useToast } from "@/components/Toast";
import { useOfflineQueue } from "@/components/OfflineQueueProvider";
import { useOptimisticLedger } from "@/components/useOptimisticLedger";
import { setDoseStatus } from "@/app/(app)/nutrition/supplement-actions";
import { localDate, shouldQueueOffline } from "@/lib/offline/queue";
import {
  DOSE_ACTION_AMBER,
  DOSE_ACTION_BRAND,
  DOSE_ACTION_ICON,
  DOSE_ACTION_LABEL,
  DOSE_ACTION_MUTED,
  DOSE_ACTION_NEUTRAL,
  DOSE_ACTION_RESOLVED,
} from "@/components/medications/dose-action-styles";

// Tri-state dose check-off (issue #232): one dose is taken, deliberately skipped,
// or clear. Shared by MedicationCard and EditableSupplementRow so BOTH surfaces
// (and every viewport) get the same control — a ✅ take toggle and a ⏭️ skip
// toggle, each flipping its state back to clear when pressed again.
//
// Online every transition calls the setDoseStatus Server Action with an explicit
// target, which keeps on-hand supply in lock-step (only crossing the taken
// boundary moves it). Offline mirrors DoseToggleButton's contract: from CLEAR you
// can queue a take ("dose") or a skip ("skip-dose") — both idempotent set-to
// intents the replay route applies once — but CHANGING an already-resolved dose
// needs a connection (the queue models resolutions, not un-resolving), so it's
// refused with a hint rather than silently dropped.
//
// A dose check-off is IDEMPOTENT per (dose, date), so it never asks anything (#2007's
// classification) — but it still gets layer 1, the shared ledger's post-success
// cooldown, keyed by the TRANSITION (from-state → target) rather than by the button.
// This is a tri-state toggle, so "the same write twice" is the transition, not the
// control: the second tap of a fat-finger double lands before the server's state has
// come back, re-sends `clear → taken`, and is absorbed — while every deliberate
// correction (un-take, un-skip, skip after take) is a DIFFERENT transition off a
// control the app has already re-rendered, and always goes through.
export type DoseVariant = "circle" | "pill";

export default function DoseStatusControl({
  doseId,
  taken,
  skipped,
  variant,
  label,
  compact = false,
  profileId,
}: {
  doseId: number;
  taken: boolean;
  skipped: boolean;
  variant: DoseVariant;
  label?: string;
  compact?: boolean;
  // The profile this dose belongs to (#858/#1373). Set on a multi-view Medications
  // board so a caregiver confirms a household member's scheduled dose without
  // switching — the action gates on the TARGET (requireProfileWriteAccess). Absent on
  // the acting board / single-view / Supplements row, so those stay byte-identical.
  // A cross-profile write always goes online (the offline replay has no target-profile
  // seam), so it's never queued.
  profileId?: number;
}) {
  // null = follow the server-provided props; a value = optimistic override held
  // after an offline queue (there's no revalidate to refresh it).
  const [optimistic, setOptimistic] = useState<
    "taken" | "skipped" | "clear" | null
  >(null);
  const ledger = useOptimisticLedger("dose-status");
  const state = optimistic ?? (taken ? "taken" : skipped ? "skipped" : "clear");
  // Whichever transition this control could start from here is the one in flight.
  const busy =
    ledger.pending(`${state}->taken`) ||
    ledger.pending(`${state}->skipped`) ||
    ledger.pending(`${state}->clear`);
  const isTaken = state === "taken";
  const isSkipped = state === "skipped";
  const toast = useToast();
  const { enqueue } = useOfflineQueue();

  // `tappedAt` is the moment the user actually pressed the control — captured by the
  // caller BEFORE the online attempt, so a confirm that falls back to the queue after
  // a slow failing request still records when the dose was taken, not when we gave up
  // (#1427). The server validates it; a skip records no intake time, so it carries none.
  async function queue(
    kind: "dose" | "skip-dose",
    next: "taken" | "skipped",
    tappedAt: Date
  ) {
    setOptimistic(next);
    await enqueue(kind, localDate(tappedAt), {
      doseId,
      ...(kind === "dose" ? { clientTakenAt: tappedAt.toISOString() } : {}),
    });
    toast(
      next === "taken"
        ? "Dose saved offline — will sync when you reconnect."
        : "Skip saved offline — will sync when you reconnect."
    );
  }

  // The online write (used by both the acting path and every cross-profile write).
  //
  // "refused" is the write core answering honestly (#2039): the dose was retired by a
  // schedule edit, or its item is paused, so NOTHING was written. That is not a network
  // failure — retrying or queueing it would keep failing — so it is reported in the
  // server's own words instead of "try again".
  async function submit(
    target: "taken" | "skipped" | "clear"
  ): Promise<"ok" | "refused" | "failed"> {
    const fd = new FormData();
    fd.set("dose_id", String(doseId));
    fd.set("status", target);
    // #858/#1373: target the row's own profile so a caregiver confirms a household
    // member's dose from its board; absent on the acting board (byte-identical).
    if (profileId != null) fd.set("profileId", String(profileId));
    try {
      const result = await setDoseStatus(fd);
      if (!result.ok) {
        toast(result.error, { tone: "error" });
        return "refused";
      }
      setOptimistic(null);
      return "ok";
    } catch {
      return "failed";
    }
  }

  // What one tap ended up doing — modeled so the ledger sees exactly one settlement.
  // "nothing" covers every arm that wrote nothing (a refusal, an offline change to an
  // already-resolved dose, a failure): those stay immediately retryable, with no
  // cooldown standing between the user and a second attempt.
  type DoseTap = "wrote" | "nothing";

  function transitionKey(target: "taken" | "skipped" | "clear"): string {
    return `${state}->${target}`;
  }

  async function apply(target: "taken" | "skipped" | "clear") {
    const key = transitionKey(target);
    // The double-tap gate (see the header note on why the transition is the key).
    if (ledger.blocked(key)) return;
    // Stamp the tap moment up front: everything below (the online round-trip, its
    // failure, the queue write) happens after the dose was actually taken.
    const tappedAt = new Date();
    await ledger.tap<DoseTap>({
      key,
      write: () => runTap(target, tappedAt),
      settle: (outcome) =>
        outcome === "wrote" ? { kind: "keep" } : { kind: "rollback" },
      onError: () => {
        toast("Couldn't update this dose. Try again.", { tone: "error" });
        return { kind: "rollback" };
      },
    });
  }

  async function runTap(
    target: "taken" | "skipped" | "clear",
    tappedAt: Date
  ): Promise<DoseTap> {
    // Cross-profile writes (#1373) are never queued — the offline replay route carries
    // no target profileId, so it would replay against the acting profile. Go straight
    // online; if the network drops, surface a retry toast rather than mis-target.
    if (profileId != null) {
      const outcome = await submit(target);
      // A refusal already said what happened, in the server's words.
      if (outcome === "failed")
        toast("Couldn't update this dose. Try again.", { tone: "error" });
      return outcome === "ok" ? "wrote" : "nothing";
    }
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
        return "nothing";
      }
      await queue(target === "taken" ? "dose" : "skip-dose", target, tappedAt);
      return "wrote";
    }

    const fd = new FormData();
    fd.set("dose_id", String(doseId));
    fd.set("status", target);
    try {
      const result = await setDoseStatus(fd);
      // The write core refused (retired dose / paused item, #2039). Nothing was
      // written, so say so rather than clearing the optimistic state as if it had been.
      if (!result.ok) {
        toast(result.error, { tone: "error" });
        return "nothing";
      }
      setOptimistic(null);
      return "wrote";
    } catch (err) {
      const stillOnline = navigator.onLine !== false;
      // A dropped connection mid-submit: queue a fresh take/skip; otherwise
      // surface a retry.
      if (
        state === "clear" &&
        target !== "clear" &&
        shouldQueueOffline(stillOnline, err)
      ) {
        await queue(
          target === "taken" ? "dose" : "skip-dose",
          target,
          tappedAt
        );
        return "wrote";
      }
      toast("Couldn't update this dose. Try again.", {
        tone: "error",
      });
      return "nothing";
    }
  }

  const takeClass =
    variant === "circle"
      ? `flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 text-sm transition ${
          isTaken
            ? "cursor-default border-brand-600 bg-brand-600 text-white"
            : isSkipped
              ? "border-black/5 bg-slate-50 text-slate-300 hover:text-brand-500 dark:border-white/5 dark:bg-ink-900/60 dark:text-slate-600 dark:hover:text-brand-400"
              : "border-black/10 text-slate-500 hover:border-brand-400 hover:text-brand-600 dark:border-white/10 dark:text-slate-400 dark:hover:text-brand-400"
        }`
      : `${compact ? DOSE_ACTION_ICON : DOSE_ACTION_LABEL} ${
          isTaken
            ? DOSE_ACTION_RESOLVED
            : isSkipped
              ? DOSE_ACTION_MUTED
              : DOSE_ACTION_BRAND
        }`;

  const skipClass =
    variant === "circle"
      ? `flex h-10 w-10 shrink-0 items-center justify-center rounded-full border-2 text-sm transition ${
          isSkipped
            ? "cursor-default border-amber-300 bg-amber-100 text-amber-700 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-300"
            : isTaken
              ? "border-black/5 bg-slate-50 text-slate-300 hover:text-slate-500 dark:border-white/5 dark:bg-ink-900/60 dark:text-slate-600 dark:hover:text-slate-400"
              : "border-black/10 text-slate-500 hover:border-amber-400 dark:border-white/10 dark:text-slate-400"
        }`
      : `${compact ? DOSE_ACTION_ICON : DOSE_ACTION_LABEL} ${
          isSkipped
            ? DOSE_ACTION_AMBER
            : isTaken
              ? DOSE_ACTION_MUTED
              : DOSE_ACTION_NEUTRAL
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
        title={isTaken ? "Taken — click to undo" : "Mark taken"}
        data-testid="dose-take"
      >
        <IconCheck
          className={variant === "circle" ? "h-4 w-4" : "h-3.5 w-3.5"}
          stroke={2.5}
        />
        {label ? (
          <span className={compact ? "sr-only" : undefined}>{label}</span>
        ) : null}
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
        {variant === "pill" ? (
          <span className={compact ? "sr-only" : undefined}>
            {isSkipped ? "Skipped" : "Skip"}
          </span>
        ) : null}
      </button>
    </div>
  );
}
