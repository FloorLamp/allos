import type { DoseTakenOutcome } from "./types";

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
// it", which is nonsense read inside the app, and carries the ✅/⏭ glyphs a chat
// message needs to be scannable while a toast has tone colour instead. Sharing
// one string would make one of the two lie about where the reader is.
//
// Pure and total over the union (no `default:` branch, so a new outcome member
// is a compile error here rather than a silently-wrong "Logged").
export interface DoseOutcomeMessage {
  text: string;
  tone: "success" | "error";
}

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
