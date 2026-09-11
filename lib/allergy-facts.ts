// The summary row of the allergy form (#5302, over #3218's primitive and #5300's
// grammar) — the second of the thirteen clinical record forms to adopt it, and the
// sibling the condition form sets the pattern with.
//
// AN ALLERGY IS A SUBSTANCE AND WHAT IT DOES TO YOU. The form asked nine labelled
// questions for a record whose allergen pick answers the first; the substance stays
// above the chips as rule 1's one identifying field, the REACTION and its SEVERITY are
// the two facts the row states (#5302's declared essentials for this form), and the
// rest — criticality, verification, status, onset, who documented it, which visit,
// notes — fall behind the one trailing affordance.
//
// WHY THE REACTION AND ITS GRADE ARE TWO CHIPS OVER ONE EDITOR. They are two facts a
// person can disagree with separately — "no, it was a wheeze" and "no, it needed
// adrenaline" — but they are stated in ONE repeatable list, because a peanut allergy
// that causes both hives AND anaphylaxis is two graded rows rather than one string
// (#1405). So both chips open the same reactions editor, which is the primitive's own
// many-chips-one-panel case: the chip's focus identity is its own, the panel's is the
// editor's (see FactChipRow's header on `focusKey`).
//
// AND WHY THERE IS NO CODE CHIP HERE, said out loud because the condition form beside
// it has one. #5287's `allergy-code` gap is real, but `AllergyForm` renders no
// `substance_code` field and `addAllergy` / `updateAllergy` parse none — the column is
// written by the importers alone. A code chip would therefore have to make the form
// post a field it has never posted, which is exactly what #5302 rules out ("every form
// posts the same action with the same fields"). The gap stays where it is modelled.
//
// WHAT A TEST SHOULD ASSERT: the chip KEYS and their states, never this file's wording.
//
// Pure: no React, no DB, no clock. The form is a renderer over `allergyFactSummary`.

import {
  allergyCriticalityLabel,
  allergyVerificationLabel,
  type AllergyManifestation,
} from "./allergy-reactions";
import {
  DEFAULT_FORMAT_PREFS,
  formatMonthDay,
  type DisplayFormatPrefs,
} from "./format-date";
import type {
  AllergyCriticality,
  AllergyStatus,
  AllergyVerificationStatus,
} from "./types";

// The facts, in the order the row draws them. The two essentials lead.
export type AllergyFactKey =
  | "reaction"
  | "severity"
  | "criticality"
  | "verification"
  | "status"
  | "onset"
  | "provider"
  | "encounter"
  | "notes";

export type AllergyFactState = "stated" | "missing";

export interface AllergyFactChip {
  key: AllergyFactKey;
  /** The sentence this chip states. */
  label: string;
  state: AllergyFactState;
}

export interface AllergyFactSummary {
  /** The facts with something to state, plus any MISSING essential, in reading order. */
  chips: AllergyFactChip[];
  /**
   * The OPTIONAL facts with nothing to state, in reading order. They render no chip at
   * all and are reached through the one trailing affordance, which names them.
   */
  more: AllergyFactKey[];
}

export const ALLERGY_FACT_NOUNS: Record<AllergyFactKey, string> = {
  reaction: "reaction",
  severity: "severity",
  criticality: "criticality",
  verification: "verification",
  status: "status",
  onset: "onset",
  provider: "who documented it",
  encounter: "visit",
  notes: "notes",
};

/** What the trailing affordance says. Names the facts it holds, in row order. */
export function moreAllergyFactsLabel(more: readonly AllergyFactKey[]): string {
  if (more.length === 0) return "";
  return `${more.map((k) => ALLERGY_FACT_NOUNS[k]).join(", ")}…`;
}

const STATUS_LABELS: Record<AllergyStatus, string> = {
  active: "Active",
  inactive: "Inactive",
  resolved: "Resolved",
};

export interface AllergyFactInput {
  /** The reaction rows exactly as the form holds them, blanks and all. */
  reactions: readonly AllergyManifestation[];
  criticality: AllergyCriticality | "";
  verification: AllergyVerificationStatus | "";
  status: AllergyStatus;
  onsetDate: string;
  /** The documenting clinician's name as typed, or blank. */
  provider: string;
  /** The linked visit's own label, or blank when no visit is linked. */
  encounter: string;
  /**
   * Whether this profile has any visit to link to. When it has none the picker does
   * not render at all, so the fact is left out of BOTH lists rather than named behind
   * the trailing affordance — offering "visit" and opening an empty editor states a
   * fact the record cannot hold (the condition row's reading of its resolved date).
   */
  linkableVisits: boolean;
  notes: string;
  prefs?: DisplayFormatPrefs;
}

const cased = (v: string): string => v[0].toUpperCase() + v.slice(1);

/**
 * Which facts the row states, which it prompts for, and which have gone behind the
 * trailing affordance.
 *
 * THE TWO ESSENTIALS PROMPT INDEPENDENTLY. A substance with a manifestation and no
 * grade states the reaction and prompts for the severity — because "Hives" and "Hives,
 * severe" are different clinical claims and the second is the one the emergency card
 * and the drug-allergy matcher read. A row with neither prompts for both.
 *
 * A BLANK ROW IS NOT A REACTION. The form always mounts at least one empty
 * manifestation pair so there is something to type into, so the summary counts only
 * rows with a manifestation — otherwise every new allergy would claim a reaction it
 * does not have.
 */
export function allergyFactSummary(f: AllergyFactInput): AllergyFactSummary {
  const prefs = f.prefs ?? DEFAULT_FORMAT_PREFS;
  const chips: AllergyFactChip[] = [];
  const more: AllergyFactKey[] = [];

  const stated = f.reactions.filter((r) => r.manifestation.trim());
  if (stated.length > 0) {
    chips.push({
      key: "reaction",
      label: stated.map((r) => r.manifestation.trim()).join(", "),
      state: "stated",
    });
  } else {
    chips.push({ key: "reaction", label: "Add a reaction", state: "missing" });
  }

  // The grades of the manifestations that HAVE one. A graded subset states what it
  // knows rather than going silent on the whole list.
  const grades = stated
    .map((r) => r.severity?.trim())
    .filter((s): s is string => !!s);
  if (grades.length > 0) {
    chips.push({
      key: "severity",
      label: grades.map(cased).join(", "),
      state: "stated",
    });
  } else {
    chips.push({ key: "severity", label: "Add a severity", state: "missing" });
  }

  // An optional fact with a value states it; an empty one goes behind the trailing chip.
  const state = (key: AllergyFactKey, value: string, label: string) => {
    if (value.trim()) chips.push({ key, label, state: "stated" });
    else more.push(key);
  };

  // Both vocabularies read back through the ONE labeller the list, the passport and the
  // emergency card already use, so a chip never names a value differently from them.
  state(
    "criticality",
    f.criticality,
    (f.criticality && allergyCriticalityLabel(f.criticality)) || ""
  );
  state(
    "verification",
    f.verification,
    (f.verification && allergyVerificationLabel(f.verification)) || ""
  );
  // Always stated: the select is born "active" and the action writes whatever it holds,
  // so the status is a default the form WILL write — the kind of fact the row exists to
  // show before it is written (lib/injury-facts' reading of the same case).
  chips.push({
    key: "status",
    label: STATUS_LABELS[f.status],
    state: "stated",
  });
  state(
    "onset",
    f.onsetDate,
    f.onsetDate.trim()
      ? `Onset ${formatMonthDay(f.onsetDate, prefs)}`
      : ""
  );
  state("provider", f.provider, f.provider.trim());
  if (f.linkableVisits) state("encounter", f.encounter, f.encounter.trim());
  // The notes MARKER, not the notes (the visit row's reading of the same field).
  state("notes", f.notes, "Notes added");

  return { chips, more };
}
