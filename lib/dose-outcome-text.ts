import type { DoseTakenOutcome, DoseUndoOutcome } from "./types";
import type { UndoOutcome } from "./undo-offer";

// What an IN-APP dose confirm says, per markDoseTaken outcome (issue #1468).
//
// The rule this exists to keep: a dose confirm NEVER unconditionally confirms.
// `markDoseTaken` returns a typed DoseTakenOutcome precisely because the button
// you tapped may be describing a world that no longer holds — the dose was
// retired by a schedule edit, its item was paused, or it was already resolved
// (and a ✅ on a dose meanwhile marked SKIPPED writes nothing). Claiming "Logged"
// there is a false confirmation of a possibly-critical medication, which is the
// #280 defect. Every surface that offers the confirm answers from the outcome.
//
// Why this is not `tapAnswerText` (lib/notifications/callback-data.ts): the
// OUTCOME is one computation and stays one — this is a formatter over it, the
// same relationship the Telegram answer has. The two differ only in channel
// register, and unavoidably so: the Telegram copy ends "Open the app to change
// it", which is nonsense read inside the app, and carries the ✅/⏭️ glyphs a chat
// message needs to be scannable while a toast has tone colour instead. Sharing
// one string would make one of the two lie about where the reader is.
//
// Pure and total over the union (no `default:` branch, so a new outcome member
// is a compile error here rather than a silently-wrong "Logged").
export interface DoseOutcomeMessage {
  text: string;
  tone: "success" | "error";
}

// The shape every in-app dose-confirm Server Action resolves with (#2106): `ok`
// means "the request was understood", and the OUTCOME — not the fact the action
// returned — is what the surface renders through doseConfirmMessage. Shared so the
// Upcoming markTaken, the household confirm and the attention-hero mark-taken all
// answer in one currency and none can quietly go back to returning void.
export type DoseConfirmResult =
  { ok: true; outcome: DoseTakenOutcome } | { ok: false; error: string };

export function doseConfirmMessage(
  outcome: DoseTakenOutcome,
  // The item's cadence phrase ("Mondays", "Every 3 days") from `cadenceLabel`, used
  // only by the off-day case. Optional so a caller with no cadence in hand still gets
  // an honest — if less specific — answer rather than a bare confirmation.
  cadence?: string | null
): DoseOutcomeMessage {
  switch (outcome) {
    case "logged":
      return { text: "Dose logged", tone: "success" };
    // An off-cadence confirm (#1602). The log WAS written — you record reality — so
    // the tone stays success; what must not happen is a bare ✓ that lets a weekly drug
    // be taken twice in a week without a word. Naming the schedule is the whole point,
    // so the phrase is included whenever the caller knows it.
    case "logged-off-day":
      return {
        text: cadence
          ? `Dose logged — note: scheduled for ${cadence}`
          : "Dose logged — note: not scheduled today",
        tone: "success",
      };
    // An idempotent repeat of a taken log — nothing new was written, and saying
    // so is honest without being alarming.
    case "already-taken":
      return { text: "Already logged as taken", tone: "success" };
    // The dose stands as SKIPPED; the tap wrote nothing. Name the status that
    // actually persists rather than letting the button confirm its own action.
    case "already-skipped":
      return {
        text: "Not logged — this dose is marked skipped",
        tone: "error",
      };
    case "skipped":
      return { text: "Dose skipped", tone: "success" };
    case "inactive":
      return { text: "Not logged — this item is paused", tone: "error" };
    case "stale-dose":
      return {
        text: "Not logged — this dose is no longer scheduled",
        tone: "error",
      };
  }
}

// Whether the overlay should drop the row after this outcome. Only the two
// outcomes that leave a TAKEN log standing resolve the dose; everything else
// leaves it due, so the row stays and the list keeps telling the truth.
export function doseResolved(outcome: DoseTakenOutcome): boolean {
  return (
    outcome === "logged" ||
    outcome === "logged-off-day" ||
    outcome === "already-taken"
  );
}

// The shape a dose-confirm UNDO Server Action resolves with (#2642) — the mirror of
// DoseConfirmResult, so the inverse answers in the same currency as the write and can
// never quietly go back to returning void.
export type DoseUndoResult =
  { ok: true; outcome: DoseUndoOutcome } | { ok: false; error: string };

// Whether THIS confirm may offer an Undo.
//
// Read against `doseResolved` above, which is a DIFFERENT question and deliberately one
// member wider. `already-taken` resolves the dose — the row leaves the due list — but the
// tap that got that answer WROTE NOTHING: a taken log was already standing, put there by
// an earlier tap, a Telegram button, or the offline replay. Offering "Undo" there would
// hand this tap the power to erase somebody else's confirm, which is the opposite of
// taking back what you just did. Only the two outcomes that mean "a new taken row exists
// BECAUSE of this tap" are undoable.
//
// Total over the union with no `default:`, so a new DoseTakenOutcome is a compile error
// here rather than a silently-undoable one.
export function doseConfirmUndoable(outcome: DoseTakenOutcome): boolean {
  switch (outcome) {
    case "logged":
    case "logged-off-day":
      return true;
    case "already-taken":
    case "already-skipped":
    case "skipped":
    case "inactive":
    case "stale-dose":
      return false;
  }
}

// What the shared Undo toast should report, per the inverse's typed outcome. Every
// refusal maps to `changed`, and honestly so: `not-taken`, `changed` and `stale-dose` all
// say the same thing to a reader — the world moved between the confirm and the Undo, so
// nothing was written over. The distinctions matter to the core and to the tests, not to
// the sentence.
export function doseUndoOutcome(outcome: DoseUndoOutcome): UndoOutcome {
  return outcome === "undone" ? { ok: true } : { ok: false, reason: "changed" };
}

// What the Undo toast says when the confirm was actually taken back. Names the
// CONSEQUENCE, not the mechanism: the row is gone, so the dose is due again and will be
// reminded about again — which is the fact the reader needs before walking away.
export const DOSE_UNDONE_MESSAGE = "Dose confirm undone — it’s due again.";
