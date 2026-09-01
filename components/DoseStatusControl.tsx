"use client";

import { useEffect, useRef, useState } from "react";
import { IconCheck, IconPlayerTrackNext } from "@tabler/icons-react";
import { useWritePipeline } from "@/components/useWritePipeline";
import { usePrefersReducedMotion } from "@/components/usePrefersReducedMotion";
import {
  setDoseStatus,
  type DoseStatusResult,
} from "@/app/(app)/nutrition/intake-actions";
import { doseConfirmMessage } from "@/lib/dose-outcome-text";
import { microMotionPlan } from "@/lib/micro-motion";
import { localDate } from "@/lib/offline/queue";
import {
  DOSE_ACTION_AMBER,
  DOSE_ACTION_BRAND,
  DOSE_ACTION_ICON,
  DOSE_ACTION_LABEL,
  DOSE_ACTION_MUTED,
  DOSE_ACTION_NEUTRAL,
  DOSE_ACTION_RESOLVED,
} from "@/components/medications/dose-action-styles";

// Tri-state dose check-off (issue #232), and THE dose domain's one row control (#4424
// ruling 3): taken, deliberately skipped, or clear, on every row that hosts a dose
// write control. IT TAKES A DAY, which is what made the row one control — the ledger
// picked between this and a hand-rolled pair on `isToday` and the sheet spelled two
// more, because `setDoseStatus` stamped today and nothing could reach yesterday.
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

// The tri-state owns the space its two targets consume, and this is the geometry
// #3938 made general — both variants render `--control-box` now, and
// `.tap-target` reaches 6px beyond every edge on a coarse
// pointer, so 6px of outer padding contains that reach and a 12px gap — twice the
// reach — lets the adjacent targets meet without overlapping. The equal negative
// margin preserves the visible controls' flow position; ScheduledDoseAction
// coordinates an outer reserve so its row still owns this full box. A fine-pointer
// desktop keeps the original compact layout. The circles used to render 44 and
// need no reserve; they are the control box now, so they take the same one.
const DOSE_STATUS_GEOMETRY: Record<DoseVariant, string> = {
  circle: "-m-1.5 gap-3 p-1.5",
  pill: "-m-1.5 gap-3 p-1.5 sm:pointer-fine:m-0 sm:pointer-fine:gap-1.5 sm:pointer-fine:p-0",
};

export default function DoseStatusControl({
  doseId,
  taken,
  skipped,
  variant,
  label,
  compact = false,
  profileId,
  date,
  itemName,
  onSettled,
  rowLeaves = false,
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
  /**
   * The day this row stands on; absent means today. Past `doseLogDays` the action
   * refuses, so a surface beyond the window offers no control (`doseWritable`).
   */
  date?: string;
  /**
   * WHICH DOSE, for the accessible name (#2615 item 2). Carried by the sheet's
   * switched-day rows, whose own buttons named their dose; absent elsewhere, including
   * the ledger, which never named one — so this leg moves no shipped name.
   */
  itemName?: string;
  /** What the ROW does with the answer; absent on a row that just re-renders. */
  onSettled?: (result: DoseStatusResult) => void;
  /**
   * Whether the surface REMOVES this row when the write lands. The control becoming its
   * done state is the receipt (#2654), so a row that stays says nothing — the sheet
   * drops a resolved row, unmounting the receipt, so there the outcome is spoken.
   */
  rowLeaves?: boolean;
}) {
  // null = follow the server-provided props; a value = optimistic override held
  // after an offline queue (there's no revalidate to refresh it).
  const [optimistic, setOptimistic] = useState<
    "taken" | "skipped" | "clear" | null
  >(null);
  // The shared client write pipeline (#3276): it stamps the surface, decides online vs
  // capture, says the sentence, and settles the one-tap ledger. This control declares
  // what a dose resolution means; it hand-wires none of that choreography.
  // WHICH AFFORDANCE THIS TAP IS (lib/one-tap.ts): `dose-day` for a stated day,
  // `dose-status` for today — two registry rows so a census can see the dated write.
  // Both hooks run and the day picks: `one-tap-call-sites.test.ts` refuses an id it
  // cannot read as a literal.
  const todayTap = useWritePipeline("dose-status");
  const datedTap = useWritePipeline("dose-day");
  const pipeline = date == null ? todayTap : datedTap;
  const state = optimistic ?? (taken ? "taken" : skipped ? "skipped" : "clear");
  // Whichever transition this control could start from here is the one in flight.
  const busy =
    pipeline.pending(`${state}->taken`) ||
    pipeline.pending(`${state}->skipped`) ||
    pipeline.pending(`${state}->clear`);
  const isTaken = state === "taken";
  const isSkipped = state === "skipped";

  // THE CONFIRM SETTLE (#2654, motion 1). A dose check-off is the app's most
  // tap-shaped confirm, and the control BECOMING its done state is the receipt —
  // which is why the happy path here has never needed a toast. The class is hung on
  // the take button for one 300 ms run after a tap that actually LANDED on `taken`:
  //
  //  * only on a tap. Server state arriving already-taken (a reload, a revalidation,
  //    another device) never animates — a settle claims "you just did that".
  //  * only toward `taken`. Un-taking is a correction, not a confirm.
  //  * only when the write said yes. A refusal or a failed request wrote nothing.
  //  * never a gate. The state change and its styling land on their own frame; this
  //    decorates a transition already made, and no tap ever waits on it.
  //
  // Under reduced motion `microMotionPlan` returns no class and no duration, so the
  // resolved styling — plus `aria-pressed`, the accessible name and the title, which
  // are the actual carriers of "taken" — simply lands. Published as
  // `data-reduced-motion` on the root so the browser suite can prove the branch.
  const reduced = usePrefersReducedMotion();
  const settlePlan = microMotionPlan("settle", reduced);
  const [settling, setSettling] = useState(false);
  const settleTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (settleTimer.current) clearTimeout(settleTimer.current);
    },
    []
  );

  function settleConfirm() {
    if (!settlePlan.animate) return;
    if (settleTimer.current) clearTimeout(settleTimer.current);
    setSettling(true);
    settleTimer.current = setTimeout(() => {
      settleTimer.current = null;
      setSettling(false);
    }, settlePlan.ms);
  }

  async function apply(target: "taken" | "skipped" | "clear") {
    const result = await pipeline.run({
      // The double-tap gate is keyed by the TRANSITION, not by the button (see the
      // header note): the second tap of a fat-finger double re-sends `clear → taken`
      // and is absorbed, while every deliberate correction is a different transition.
      key: `${state}->${target}`,
      fields: {
        dose_id: String(doseId),
        status: target,
        // THE STATE THIS CONTROL WAS SHOWING (#280) — see `setDoseStatus`.
        from: state,
        // Omitted on a today mount so its post stays byte-identical.
        ...(date != null ? { date } : {}),
        // #858/#1373: target the row's own profile so a caregiver confirms a household
        // member's dose from its board; absent on the acting board (byte-identical).
        ...(profileId != null ? { profileId: String(profileId) } : {}),
      },
      action: setDoseStatus,
      // "refused" is the write core answering honestly (#2039): the dose was retired by
      // a schedule edit, or its item is paused, so NOTHING was written. That is not a
      // network failure, so it is reported in the server's own words.
      //
      // A landed transition says nothing: the control BECOMING its done state is the
      // receipt (#2654), and there is no toast to hang an Undo on.
      settle: (result) => {
        onSettled?.(result);
        if (!result.ok)
          return {
            wrote: false,
            announce: {
              message: result.error,
              tone: "error" as const,
              undo: null,
            },
          };
        // A clear writes nothing anybody needs told; `unchanged` is the double-tap.
        const spoken =
          rowLeaves &&
          result.outcome !== "cleared" &&
          result.outcome !== "unchanged"
            ? doseConfirmMessage(result.outcome)
            : null;
        return {
          wrote: true,
          announce: spoken
            ? { message: spoken.text, tone: spoken.tone, undo: null }
            : ("silent" as const),
        };
      },
      failureMessage: "Couldn't update this dose. Try again.",
      offline: (tappedAt) => {
        // Cross-profile writes (#1373) are never queued — the offline replay route
        // carries no target profileId, so a capture would replay against the acting
        // profile. Go online; a dropped link surfaces the retry sentence.
        if (profileId != null) return { kind: "attempt" };
        // Only a fresh take/skip from a CLEAR dose is queueable. Anything that changes
        // an already-resolved dose (including clearing it) needs a live connection —
        // the queue models resolutions, not un-resolving.
        if (state !== "clear" || target === "clear")
          return {
            kind: "refuse",
            message: "You're offline — reconnect to change a logged dose.",
          };
        const flow = target === "taken" ? "dose" : "skip-dose";
        return {
          kind: "capture",
          flow,
          // THE ROW'S DAY, NOT THE TAP'S: a past-day capture replays against the day
          // it names.
          date: date ?? localDate(tappedAt),
          // The server validates the stamp; a skip records no intake time, so it
          // carries none.
          payload: {
            doseId,
            ...(flow === "dose"
              ? { clientTakenAt: tappedAt.toISOString() }
              : {}),
          },
          keptMessage:
            target === "taken"
              ? "Dose saved offline — will sync when you reconnect."
              : "Skip saved offline — will sync when you reconnect.",
        };
      },
    });
    // A CAPTURE SETTLES THE ROW TOO: the pipeline runs `settle` only for a write that
    // reached the server, so a queued tap would leave a resolved row in the list.
    if (result === "captured") onSettled?.({ ok: true, outcome: "logged" });
    if (result === "nothing") return;
    // A server write is authoritative, so the optimistic override is dropped and the
    // props take over; a capture has no revalidate behind it, so the override stands in
    // for the queued write until replay.
    setOptimistic(result === "wrote" ? null : (target as "taken" | "skipped"));
    // The one place that knows a tap both aimed at `taken` AND landed.
    if (target === "taken") settleConfirm();
  }

  // The visible verb stays short; the name says WHICH dose when the row does not.
  const named = (verb: string) => (itemName ? `${verb} — ${itemName}` : verb);

  const takeClass =
    variant === "circle"
      ? `tap-target flex h-(--control-box) w-(--control-box) shrink-0 items-center justify-center rounded-full border-2 text-sm transition ${
          isTaken
            ? "cursor-default border-(--seg-active-bg) bg-(--seg-active-bg) text-(--seg-active-fg)"
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
      ? `tap-target flex h-(--control-box) w-(--control-box) shrink-0 items-center justify-center rounded-full border-2 text-sm transition ${
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
      className={`flex shrink-0 items-center ${DOSE_STATUS_GEOMETRY[variant]}`}
      data-testid="dose-status"
      data-variant={variant}
      data-reduced-motion={reduced ? "true" : "false"}
    >
      {/* Selected-state registry keep (#2730): these buttons WRITE typed dose
          outcomes; they do not select a view, destination, or list filter. */}
      <button
        type="button"
        onClick={() => apply(isTaken ? "clear" : "taken")}
        disabled={busy}
        data-settling={settling ? "true" : "false"}
        className={`${takeClass}${settling ? " motion-settle" : ""}`}
        aria-pressed={isTaken}
        aria-label={named(isTaken ? "Mark not taken" : "Mark taken")}
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
        aria-label={named(isSkipped ? "Undo skip" : "Skip this dose")}
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
