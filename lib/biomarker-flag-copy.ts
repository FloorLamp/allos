// Copy policy for the newly-flagged biomarker attention item (issues #514 / #526).
// A flagged item fires when a lab reading is out of range or non-optimal — it is
// the MANAGEMENT signal ("your HDL came back low, look at it"), distinct from the
// retest clock (lib/biomarker-retest-copy.ts, "consider redrawing this old value").
//
// The defect this module fixes (#526): the flag item was a dead end — title was
// the bare analyte name and the detail read "Flagged result 55", stating no
// action. Triage's contract is "here's a thing → here's what to do", so the title
// now carries the verb ("Review HDL Cholesterol") and the item deep-links to the
// analyte's series. Kept pure + tested so the card and the Upcoming page share one
// copy computation (issue #524's one item builder).

import { flagLabel } from "./reference-range";
import type { MedicalFlag } from "./types";

// The action-carrying title for a flag item: the verb up front so the row reads as
// an action ("Review HDL Cholesterol"), never a bare analyte name that looks like a
// diagnosis (#526). Same copy rule as the retest title ("Retest …").
export function biomarkerFlagTitle(name: string): string {
  return `Review ${name}`;
}

// The detail line for a flag item: the reading's status and value, so the row
// explains WHY it needs a look ("Flagged low — 55 mg/dL"). Value is optional (some
// qualitative flags carry no numeric value).
export function biomarkerFlagDetail(
  flag: MedicalFlag | string | null | undefined,
  value: string | null | undefined
): string {
  const status = flagLabel(flag).toLowerCase();
  const v = value?.trim();
  return v ? `Flagged ${status} — ${v}` : `Flagged ${status}`;
}
