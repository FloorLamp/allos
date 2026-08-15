// The DRAFT rule (#2870 step 3, owner-ruled): a started-but-unfinished manual
// activity with ZERO logged content — no sets, no components, no note, no
// distance — is a draft. It exists because create-at-start writes the row at
// the session's first second; until something is logged (or the session
// finishes) it is an address, not an entry, and it renders NOWHERE but its own
// page. The same emptiness bar gates the close-path abandonment
// (lib/workout-finish.ts discardWorkoutSessionIfEmpty) and the finish refusal
// (#1205 §4) — one rule, read from the row here so list surfaces can apply it
// without a per-row set query.

import { parseComponents } from "./types/training";

export interface DraftCandidateRow {
  start_time: string | null;
  end_time: string | null;
  duration_min: number | null;
  components: string | null;
  notes: string | null;
  distance_km: number | null;
  source: string | null;
}

export function isDraftActivityRow(
  row: DraftCandidateRow,
  setCount: number
): boolean {
  // Imports are never drafts (source rows arrive whole), and the live-draft
  // shape is started-but-unended with no stored duration.
  if (row.source != null) return false;
  if (row.start_time == null || row.end_time != null) return false;
  if (row.duration_min != null) return false;
  // Any logged value keeps the row an entry: a set, a component, a note, a
  // distance ("zero sets/values" is the bar).
  if (setCount > 0) return false;
  if (parseComponents(row.components).length > 0) return false;
  if ((row.notes ?? "").trim() !== "") return false;
  if (row.distance_km != null) return false;
  return true;
}
