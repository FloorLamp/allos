"use client";

import SubmitButton from "@/components/SubmitButton";
import { useUndoableAction } from "@/components/useUndoableAction";
import {
  DOSE_UNDONE_MESSAGE,
  doseConfirmMessage,
  doseConfirmUndoable,
  doseUndoOutcome,
} from "@/lib/dose-outcome-text";
import type {
  DoseConfirmResult,
  DoseUndoResult,
} from "@/lib/dose-outcome-text";

// The dose-confirm form for surfaces whose feedback channel is a toast (#2106): the
// household card's per-member "Confirm" and the dashboard attention hero's "Mark
// taken". Both are registered under the `dose-status` one-tap affordance, whose
// declared feedback is `outcome-toast` — the tap is ANSWERED from markDoseTaken's
// typed outcome and never confirmed unconditionally (the #280 rule, the same
// rendering the quick-entry dose list and the Telegram tap already do).
//
// The server parent passes the action (each surface keeps its own gate: the
// household confirm re-checks write access on the CARD's profile, the hero on the
// acting one) plus the hidden id fields; this component only renders the answer:
// a refusal — item paused, dose retired, dose standing as skipped — toasts in the
// error tone and the row stays, because it is still due; a success toasts the
// outcome's own wording ("Dose logged" / "Already logged as taken").
//
// ── Undo (#2642) ──────────────────────────────────────────────────────────────
// When the parent supplies `undoAction`, a success that this tap actually WROTE also
// carries an Undo, through the shared act→undo toast. Two things are load-bearing:
//
//   • `doseConfirmUndoable` is the gate, not `doseResolved`. An `already-taken` answer
//     resolves the dose but wrote nothing — the taken row was somebody's earlier confirm
//     — so no Undo is offered and this tap keeps no power over a write it did not make.
//   • the undo POSTS ids and re-derives everything server-side. It rebuilds its form from
//     the same declared `fields` rather than reusing the submitted FormData, so the
//     inverse can only ever name the dose this button names.
export default function DoseConfirmButton({
  action,
  undoAction,
  fields,
  className,
  testid,
  ariaLabel,
  children,
}: {
  action: (formData: FormData) => Promise<DoseConfirmResult>;
  // The typed inverse for this surface (#2642). Optional: a surface with no inverse
  // wired simply offers no Undo, which is the honest default rather than a broken one.
  undoAction?: (formData: FormData) => Promise<DoseUndoResult>;
  // Hidden form fields posted with the action — ids only, never objects.
  fields: Record<string, string | number>;
  className?: string;
  testid?: string;
  // An accessible name that says WHICH dose (#2615 item 2). The visible label is
  // deliberately short ("Confirm — Mia"), which on a card listing a morning and an
  // evening dose of the same supplement leaves two controls announcing the same
  // words. Pass the row's own distinguishing attributes here; omitted, the visible
  // label is the accessible name as before.
  ariaLabel?: string;
  children: React.ReactNode;
}) {
  const announce = useUndoableAction();

  async function confirm(fd: FormData) {
    let result: DoseConfirmResult;
    try {
      result = await action(fd);
    } catch {
      announce({
        message: "Couldn't log that dose. Try again.",
        tone: "error",
      });
      return;
    }
    if (!result.ok) {
      announce({ message: result.error, tone: "error" });
      return;
    }
    const { text, tone } = doseConfirmMessage(result.outcome);
    const undo = undoAction;
    announce({
      message: text,
      tone,
      undo:
        undo && doseConfirmUndoable(result.outcome)
          ? {
              undoneMessage: DOSE_UNDONE_MESSAGE,
              run: async () => {
                const undoFd = new FormData();
                for (const [name, value] of Object.entries(fields)) {
                  undoFd.set(name, String(value));
                }
                let undone: DoseUndoResult;
                try {
                  undone = await undo(undoFd);
                } catch {
                  return { ok: false, reason: "failed" };
                }
                return undone.ok
                  ? doseUndoOutcome(undone.outcome)
                  : { ok: false, reason: "failed" };
              },
            }
          : null,
    });
  }

  return (
    <form action={confirm} className="shrink-0">
      {Object.entries(fields).map(([name, value]) => (
        <input key={name} type="hidden" name={name} value={value} />
      ))}
      <SubmitButton
        pendingLabel="…"
        data-testid={testid}
        className={className}
        aria-label={ariaLabel}
      >
        {children}
      </SubmitButton>
    </form>
  );
}
