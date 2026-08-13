// The UNDO OFFER — the shared vocabulary for "the write landed; here is how to take it
// back" (#2642).
//
// The app already had ONE undo lifecycle, but only for DELETES: `lib/undo-delete.ts`
// captures the row, `components/useUndoableDelete.ts` toasts it, and the "Undo" action
// posts a token back. Everything else that wanted the same feel re-derived the toast
// duration by hand — 15000 appeared as a local constant in three client components — and
// had no shared word for a refusal. This module is that half made shared: the window, the
// refusal vocabulary, and the pure decision of whether a given announcement may carry an
// Undo at all.
//
// ── The contract ──────────────────────────────────────────────────────────────────
//
// A write may offer an undo when its INVERSE is COMPLETE and LOCAL:
//
//   • complete — running it puts the world back exactly as it was, children and
//     side-state included. An undo that restores the row but not its children is a
//     data-integrity defect wearing a UX improvement (AGENTS.md, row-op completeness).
//   • local — nothing left the machine. An act that SENT, PUBLISHED or DELIVERED
//     something is not undoable by deleting a row: the message is already read.
//   • re-derived — the inverse re-checks validity server-side before writing, exactly as
//     `logUsualFoodCore` re-derives its offer. An inverse that trusts the client's memory
//     of the prior state is not an undo, it is a second unvalidated write.
//
// UNDO IS NOT A SUBSTITUTE FOR A CONFIRM. A consequence-stating confirm on a
// hard-to-reverse or safety-relevant transition — obligation demotion, retiring a dose
// with logs, ending an episode, stopping a medication course — is doctrine, not friction,
// and adding an undo somewhere else never earns the right to remove one of those.
//
// ── How this would learn it should stop (#2385) ───────────────────────────────────
//
// WORKING: fewer flows abandoned mid-way, and fewer confirmed-then-immediately-redone
// writes, because the cheap escape hatch is on the far side of the tap.
// WRONG: undos rising over time, or destructive taps taken and NOT undone at a higher
// rate than before — that second one means a confirm was load-bearing and this replaced
// a question with a shrug.
// DECEPTIVE SUCCESS: taps-per-task falls and every flow feels quicker while accidental
// writes rise; the undo affordance is counted as used while the accident it was supposed
// to catch is what produced the tap. Local queries over data the instance already holds,
// prose in the issue and here — never telemetry, never a user-facing score.
//
// Pure by construction: no DB, no React, no clock.

// How long a toast carrying an Undo stays up (ms). The delete half's holding row itself
// lives for the admin-configured Trash window (30 days by default, #2013) and Data →
// Trash renders every capture until it expires, so this is the convenient affordance
// rather than the only one — but it still lingers well past the default success toast,
// because catching a mis-tap in place beats navigating to find it. ONE number: three
// client components used to carry their own copy of it.
export const UNDO_TOAST_MS = 15000;

// Why an undo did not land. Three words, deliberately, because a caller that cannot map
// its domain refusal onto one of them is telling us its inverse is not an undo:
//   expired — the capture the undo needed is gone (swept, or past its window)
//   changed — the world moved: the state the inverse expected no longer stands, so it
//             refused rather than writing over whatever is there now
//   failed  — the request itself did not complete (offline, a thrown action)
export type UndoRefusal = "expired" | "changed" | "failed";

// What an inverse actually did. `ok` is the whole success shape: an undo that has to
// report a partial result is not complete, and belongs behind a confirm instead.
export type UndoOutcome = { ok: true } | { ok: false; reason: UndoRefusal };

// The Undo the toast will carry. `undoneMessage` is the domain's own word for what came
// back ("Restored." for a row, "Dose confirm undone" for a ledger tick) — one shared
// window and one shared refusal vocabulary, but never one shared claim about what
// happened.
export interface UndoOffer {
  undoneMessage: string;
  // Re-derives validity server-side and answers. Never throws for a refusal — a throw is
  // reported as `failed`.
  run: () => Promise<UndoOutcome>;
}

// The refusal line, per reason. Kept here (not per surface) so the same failure never
// reads two ways; the `expired` wording is the one the delete toast has shown since #30
// and is pinned by browser tests.
export function undoRefusalText(reason: UndoRefusal): string {
  switch (reason) {
    case "expired":
      return "Couldn’t undo — it may have expired.";
    case "changed":
      return "Couldn’t undo — this has changed since.";
    case "failed":
      return "Couldn’t undo — try again.";
  }
}

// What a toast announcing a write should look like — the pure half of
// `components/useUndoableAction.ts`, so the rule below is testable without React.
export interface UndoToastPlan {
  message: string;
  tone: "success" | "error";
  // undefined = let the toast pick its tone default.
  duration: number | undefined;
  offerUndo: boolean;
}

// THE RULE: an Undo rides only on a SUCCESS. A refusal wrote nothing, so there is nothing
// to take back, and an "Undo" beside "Not logged — this item is paused" would invite a
// tap that either no-ops or — worse — reverses somebody else's earlier write. A caller
// that has no inverse in hand passes `hasUndo: false` and gets the ordinary toast.
export function undoToastPlan(announcement: {
  message: string;
  tone?: "success" | "error";
  hasUndo: boolean;
}): UndoToastPlan {
  const tone = announcement.tone ?? "success";
  const offerUndo = announcement.hasUndo && tone === "success";
  return {
    message: announcement.message,
    tone,
    duration: offerUndo ? UNDO_TOAST_MS : undefined,
    offerUndo,
  };
}
