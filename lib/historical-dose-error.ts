// Every refusal the historical-dose cores can answer with, rendered as the message
// the surface shows. ONE mapping (#221), so the backfill, the medication-card
// amendment, and the illness-episode amendment (#2228 decision 6 — the same core
// since updateAdministrationLog was deleted) can never drift into describing the
// same refusal differently — and so `stale-dose` keeps meaning what it says. Before
// #1933 a SUPPLEMENT dose came back `stale-dose` from a core that had simply
// refused its kind, telling the user a dose they were looking at did not exist.
//
// Pure and DB-free so both the "use server" action modules can import it (a
// "use server" file may export only actions, so the mapping cannot live in one).

import type { HistoricalDoseOutcome } from "./types";

export function historicalDoseErrorMessage(
  outcome: Exclude<HistoricalDoseOutcome, { kind: "logged" }>
): string {
  switch (outcome.kind) {
    case "already-taken":
      return "That scheduled dose is already recorded for this date.";
    case "already-skipped":
      return "That scheduled dose is marked skipped for this date.";
    case "duplicate":
      return "A dose is already recorded at about this time.";
    case "outside-course":
      return "This medication was not active on that date.";
    case "invalid-time":
      return "Choose a date and time that are not in the future.";
    case "stale-dose":
    default:
      return "That dose is no longer available. Refresh and try again.";
  }
}
