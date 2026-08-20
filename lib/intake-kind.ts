// Kind derivation for the one intake form (#3216).
//
// THE DECISION THIS REPLACES. Three shells asked the kind up front — you reached
// /medications or Nutrition → Supplements and the door had already answered. The
// merged form opens on ONE field, the name, and derives the kind from what the name
// already says: the medication vocabulary (#817), the supplement catalog, or a
// sibling item already drawing from the same shared bottle (#1374). The answer is
// rendered as a correctable chip, never as a question the user had to answer first.
//
// A question is asked only when the evidence genuinely does not decide: a name in
// BOTH vocabularies (melatonin is a medication entry and a catalog supplement) or a
// name in neither. Those two are different states — the copy differs — so they are
// different sources, not one "unknown".
//
// Pure (no React, no DB): the derivation is unit-tested directly and the form is a
// renderer over it.

import type { IntakeItemKind } from "./types/intake";

export type IntakeKindSource =
  // A kind-locked door (/medications, Nutrition → Supplements) answered it.
  | "locked"
  // The person corrected it with the chip's `change` toggle.
  | "chosen"
  | "medication-vocabulary"
  | "supplement-vocabulary"
  // A sibling item already linked to the picked shared bottle (a bottle has no kind).
  | "bottle-sibling"
  // Undecided: the two shapes of "ask once".
  | "ambiguous"
  | "unknown";

export interface IntakeKindDerivation {
  // Null means the form must ask — `source` says which of the two asks.
  kind: IntakeItemKind | null;
  source: IntakeKindSource;
  // Whether the chip offers a `change` toggle. A locked door has nothing to change.
  correctable: boolean;
}

export interface IntakeKindEvidence {
  // Trimmed name currently in the one field. Blank ⇒ nothing to derive from.
  name: string;
  // The host's kind-locked door, when it has one.
  locked?: IntakeItemKind | null;
  // The person's own correction, cleared whenever the name changes.
  chosen?: IntakeItemKind | null;
  // The kind of an item already linked to the picked bottle, when there is one.
  bottleSiblingKind?: IntakeItemKind | null;
  inMedicationVocabulary: boolean;
  inSupplementVocabulary: boolean;
}

// Precedence, most authoritative first. The door beats everything (it is not a guess);
// an explicit correction beats a guess; an UNAMBIGUOUS vocabulary hit beats the bottle
// sibling (the vocabularies describe the substance, the sibling only describes how one
// household member filed it); the sibling breaks a vocabulary tie; anything left is an
// ask, and which ask depends on whether the name was recognized at all.
export function deriveIntakeKind(
  evidence: IntakeKindEvidence
): IntakeKindDerivation {
  if (evidence.locked)
    return { kind: evidence.locked, source: "locked", correctable: false };
  if (evidence.chosen)
    return { kind: evidence.chosen, source: "chosen", correctable: true };

  const name = evidence.name.trim();
  const med = name !== "" && evidence.inMedicationVocabulary;
  const supp = name !== "" && evidence.inSupplementVocabulary;

  if (med && !supp)
    return {
      kind: "medication",
      source: "medication-vocabulary",
      correctable: true,
    };
  if (supp && !med)
    return {
      kind: "supplement",
      source: "supplement-vocabulary",
      correctable: true,
    };

  if (evidence.bottleSiblingKind)
    return {
      kind: evidence.bottleSiblingKind,
      source: "bottle-sibling",
      correctable: true,
    };

  return {
    kind: null,
    source: med && supp ? "ambiguous" : "unknown",
    correctable: true,
  };
}

// The chip's two halves: what the form decided, and why. Copy lives here so the chip,
// the ask, and the tests quote one wording — the chip is a SENTENCE about provenance,
// not a label ("Medication" alone would be indistinguishable from an upfront choice
// the user made).
export const INTAKE_KIND_NOUN: Record<IntakeItemKind, string> = {
  medication: "Medication",
  supplement: "Supplement",
};

export function intakeKindReason(source: IntakeKindSource): string | null {
  switch (source) {
    case "medication-vocabulary":
      return "matched the medication list";
    case "supplement-vocabulary":
      return "matched the supplement list";
    case "bottle-sibling":
      return "from the shared bottle";
    case "chosen":
      return "you chose this";
    default:
      return null;
  }
}

// The prompt for the two ask states. An unrecognized name and a name in both lists
// are asked DIFFERENTLY: one is "we don't know it", the other "we know it as both".
export function intakeKindAskPrompt(source: IntakeKindSource): string {
  return source === "ambiguous"
    ? "This is on both lists. Which is it for you?"
    : "Is this a medication or a supplement?";
}
