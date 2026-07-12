import type { SaveActivityOutcome } from "./types";

// Pure helper for the activity form's auto-save (issue #332). saveActivity now
// answers with a typed outcome; persist() confirms a save ONLY when it persisted.
// On a failure outcome the form must keep its dirty signature (so the edit
// survives, the auto-saver can retry, and navigation stays blocked) and surface an
// honest message instead of "Saved ✓". This maps each failure reason to the user
// text — kept pure so it's unit-testable without the React component.
export function saveOutcomeMessage(
  reason: Extract<SaveActivityOutcome, { ok: false }>["reason"]
): string {
  switch (reason) {
    case "not-owned":
      // The untrusted form id isn't the active profile's — e.g. an auto-save
      // fired after a profile switch or from a stale tab. Reopening reloads a
      // valid id for the active profile.
      return "Couldn’t save — this activity isn’t on the active profile. Reopen it.";
    case "invalid":
      // Title/date failed the server-side guard (the client gate normally
      // prevents this; belt-and-suspenders if a bad value slips through).
      return "Couldn’t save — check the title and date.";
    case "restricted":
      // The active profile is below the instance's minimum training age (#488) —
      // activity logging is unavailable for it (the view/edit surfaces are hidden),
      // so the create path refuses rather than persisting an unreachable row.
      return "Couldn’t save — activity logging isn’t available for this profile.";
  }
}
