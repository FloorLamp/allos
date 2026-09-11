// The summary row of the family-history form (#5302, over #3218's primitive and
// #5300's grammar) — the third of the three care-overview forms.
//
// A FAMILY-HISTORY ROW IS ONE CONDITION IN ONE RELATIVE. The form asked ten labelled
// questions — relative, condition, code, code system, relationship, family side, age
// at onset, deceased, age at death, cause of death, notes — for a record whose
// ICD-10-CM pick already answers the code. The CONDITION stays above the chips as rule
// 1's one identifying field (it is also the form's required value), the row states the
// relative and the code, and the rest fall behind the one trailing affordance.
//
// WHY `relation` IS ESSENTIAL. It is the other half of what the row asserts, and the
// only half the reader cannot infer: `familyRelativeLabel` falls back to a bare
// "Relative", which is the row saying out loud that it cannot name whose history this
// is. The risk classifier does not consult it today (#1039 Ask 5 defers first-degree
// gating), so this is a legibility argument and not a derivation one — said plainly
// rather than borrowed from a sibling form's stronger reason.
//
// AND WHY `code` IS ESSENTIAL, which is the condition form's reason at this address.
// The risk classifier reads a family row code-FIRST with a name-substring fallback
// (`FamilyConditionInput` carries the row's code/code_system so the code table counts,
// #1030), and this form's own picker is the curated ICD-10-CM vocabulary the condition
// form uses. A free-typed relative's condition therefore reaches the screening cadence
// only if its spelling happens to match a keyword stem. The dashed prompt is that gap's
// sentence, said where it can be answered.
//
// THE THREE DEATH FIELDS ARE ONE FACT. `deceased`, `age_at_death` and `cause_of_death`
// describe a single event and are already read back as one line by `familyDeathLabel`
// ("Died at 52 — Myocardial infarction", with an age or a cause each implying the death
// they describe). So the row states ONE `death` chip over that same labeller and opens
// ONE editor holding all three controls — a chip states a fact, and three chips here
// would state one fact three times.
//
// WHY `relationship` AND `onsetAge` ARE OPTIONAL, both of which look like candidates.
// An unstated `relation_type` is DEFINED: lib/family-relation reads NULL as genetic —
// "absence stays absence; nothing here invents a discriminator the user never stated" —
// so prompting would ask for a value whose absence is already the documented reading.
// A missing `onset_age` is conservative by the same discipline: it activates the base
// site factor and never a fabricated early onset, and the early-onset tightening it
// feeds (#1039 path 4) exists for colorectal and breast only, so a dashed prompt on
// every relative's diabetes would overstate what the age buys.
//
// WHAT A TEST SHOULD ASSERT: the chip KEYS and their states, never this file's wording.
//
// Pure: no React, no DB, no clock. The form is a renderer over `familyFactSummary`.

import { familyDeathLabel } from "./family-relation";
import { recordFactRow, type RecordFactSummary } from "./record-facts";
import type { FamilyLineage, FamilyRelationType } from "./types";

// The facts, in the order the row draws them. The two essentials lead, and the
// qualifiers of the relative sit next to the relative they qualify.
export type FamilyHistoryFactKey =
  | "relation"
  | "code"
  | "relationship"
  | "lineage"
  | "onsetAge"
  | "death"
  | "notes";

// The nouns, so the trailing affordance can name what it holds.
export const FAMILY_HISTORY_FACT_NOUNS: Record<FamilyHistoryFactKey, string> = {
  relation: "relative",
  code: "code",
  relationship: "relationship",
  lineage: "family side",
  onsetAge: "age at onset",
  death: "death",
  notes: "notes",
};

// SHORT labels for the chip. The select's own options spend a clause explaining each
// value ("Adopted — not genetic"), which is right beside the control and far too long
// for a chip; these are the same four values as a plain noun.
const RELATIONSHIP_LABELS: Record<FamilyRelationType, string> = {
  genetic: "Genetic",
  half: "Half sibling",
  adopted: "Adopted",
  step: "Step",
};

export interface FamilyHistoryFactInput {
  /** The relative as typed or picked — blank means the row cannot say whose. */
  relation: string;
  code: string;
  /** Qualifies the code chip; never a chip of its own. */
  codeSystem: string;
  /**
   * True while the code on screen came from the catalog pick and the person has not
   * typed over it (#846).
   */
  codeSuggested: boolean;
  relationship: FamilyRelationType | "";
  lineage: FamilyLineage | "";
  /** The relative's age at diagnosis, as the number field holds it. */
  onsetAge: string;
  /** The death fields exactly as the form holds them; read back as one line. */
  deceased: boolean;
  ageAtDeath: string;
  causeOfDeath: string;
  notes: string;
}

const cased = (v: string): string => v[0].toUpperCase() + v.slice(1);

/**
 * Which facts the row states, which it prompts for, and which have gone behind the
 * trailing affordance.
 */
export function familyFactSummary(
  f: FamilyHistoryFactInput
): RecordFactSummary<FamilyHistoryFactKey> {
  const row = recordFactRow<FamilyHistoryFactKey>();

  const relation = f.relation.trim();
  if (relation) row.stated("relation", relation);
  else row.missing("relation", "Add the relative");

  const code = f.code.trim();
  const system = f.codeSystem.trim();
  if (code)
    row.stated("code", system ? `${code} · ${system}` : code, f.codeSuggested);
  else row.missing("code", "Add a code");

  row.state(
    "relationship",
    f.relationship,
    f.relationship ? RELATIONSHIP_LABELS[f.relationship] : ""
  );
  row.state("lineage", f.lineage, f.lineage ? cased(f.lineage) : "");
  row.state(
    "onsetAge",
    f.onsetAge,
    f.onsetAge.trim() ? `Onset at ${f.onsetAge.trim()}` : ""
  );
  // Through the ONE labeller the list, the passport and the profile summary already
  // read these three columns with, so the chip cannot state a death differently from
  // the row it will become. Null when the row asserts no death at all, which sends the
  // fact behind the trailing affordance rather than onto the row as a claim.
  const death = familyDeathLabel({
    deceased: f.deceased ? 1 : 0,
    age_at_death: f.ageAtDeath.trim() ? Number(f.ageAtDeath) : null,
    cause_of_death: f.causeOfDeath,
  });
  row.state("death", death ?? "", death ?? "");
  // The notes MARKER, not the notes (the visit row's reading of the same field).
  row.state("notes", f.notes, "Notes added");

  return row.summary();
}
