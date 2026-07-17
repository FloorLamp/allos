// Pure episode-end medication reconciliation (issue #880). No DB or network — everything
// here is a pure function of its inputs, unit-tested in
// lib/__tests__/episode-med-reconcile.test.ts.
//
// When an illness episode ends, OTC meds added mid-illness (the 2am ibuprofen, #843
// quick-add) otherwise stay "Current" forever, misrepresenting the med list that IS the
// doctor-visit artifact. This module decides, for each of the profile's ACTIVE meds,
// whether it is ASSOCIATED with the episode and whether closing its course should be
// DEFAULT-CHECKED. The hard line is SUGGEST-ONLY (#560): the app never silently stops
// therapy — an Rx course is LISTED but never pre-checked; the user confirms.

// The episode window to test membership against. `start` is the inclusive first active
// day (null = active before the change-log floor). `endInclusive` is the last day that
// counts as "inside" — today for an open episode being ended now, or the last active day
// for a backdated (stale-nudge) end.
export interface EpisodeRange {
  start: string | null;
  endInclusive: string;
}

// One of the profile's active medications, with the facts association keys on.
export interface EpisodeMedInput {
  itemId: number;
  name: string;
  asNeeded: boolean; // as_needed === 1 (PRN)
  rx: boolean; // rx === 1 (prescription); OTC = false (#851 rx flag)
  hasOpenCourse: boolean; // currently active/open — only open meds are stop candidates
  createdOn: string; // the med's created_at DATE (YYYY-MM-DD)
  administrationDates: string[]; // 'taken' administration DATES (any order)
}

// "otc-prn" is the conservative default-check class; "course" is everything else
// associated (an Rx, or a scheduled non-PRN course) — listed but never pre-checked.
export type EpisodeMedClass = "otc-prn" | "course";

export interface EpisodeMedSuggestion {
  itemId: number;
  name: string;
  klass: EpisodeMedClass;
  defaultChecked: boolean;
}

function inRange(date: string, range: EpisodeRange): boolean {
  return (
    (range.start == null || date >= range.start) && date <= range.endInclusive
  );
}

// Classify one med against the episode range, or null when it is NOT associated.
// Association (whether it's LISTED) is DERIVED, no FKs (the house pattern): a med is
// associated when it was CREATED during the range, OR is PRN with EVERY administration
// inside the range (and at least one). A med with no open course is never a candidate
// (nothing to close).
//
// DEFAULT-CHECKED (pre-checked, the conservative class) is stricter: PRN + OTC (rx flag)
// AND CREATED DURING the episode. Everything else associated is LISTED but UNCHECKED:
//   - an Rx course (klass "course", "course finished?") — finishing an antibiotic is a
//     real decision, never a default (#560);
//   - an OTC PRN med CREATED BEFORE the episode but used during it — a standing med the
//     user may keep; listed with "Also stop?" but not pre-checked.
// So the only rows that arrive pre-checked are the meds unambiguously added FOR this
// illness (the #843 2am ibuprofen), exactly the ones safe to retire on resolution.
export function classifyEpisodeMed(
  med: EpisodeMedInput,
  range: EpisodeRange
): EpisodeMedSuggestion | null {
  if (!med.hasOpenCourse) return null;
  const createdDuring = inRange(med.createdOn, range);
  const prnUsedInside =
    med.asNeeded &&
    med.administrationDates.length > 0 &&
    med.administrationDates.every((d) => inRange(d, range));
  const associated = createdDuring || prnUsedInside;
  if (!associated) return null;
  const otcPrn = med.asNeeded && !med.rx;
  return {
    itemId: med.itemId,
    name: med.name,
    klass: otcPrn ? "otc-prn" : "course",
    defaultChecked: otcPrn && createdDuring,
  };
}

// The full episode-end checklist: every associated med, in a stable order (default-checked
// OTC-PRN meds first, then Rx/scheduled courses; name-tiebroken), so the UI renders the
// pre-checked "Also stop?" rows above the unchecked "Course finished?" ones.
export function episodeMedChecklist(
  meds: EpisodeMedInput[],
  range: EpisodeRange
): EpisodeMedSuggestion[] {
  return meds
    .map((m) => classifyEpisodeMed(m, range))
    .filter((s): s is EpisodeMedSuggestion => s !== null)
    .sort(
      (a, b) =>
        Number(b.defaultChecked) - Number(a.defaultChecked) ||
        a.name.localeCompare(b.name)
    );
}
