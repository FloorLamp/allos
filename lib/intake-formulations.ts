// The formulation chip row of the one intake form (#3216, owner decision 2).
//
// THE FACT IT SURFACES. One ingredient is several products. Ibuprofen is an adult
// tablet at one strength and a children's oral suspension at another, and the #798
// datasets already carry the concentrations — but only the pediatric band picker,
// buried inside the dose block, ever offered the choice. As a derived chip row at the
// top of the dose editor (#5301), the choice sits with the fact it changes, and the
// profile's age picks the default rather than making anyone find it.
//
// WHAT A SWITCH RE-DERIVES, and why each follows from the product rather than from
// the person:
//   • the dose amount — a suspension's dose is a volume, so the amount carries both
//     the milligrams and the millilitres;
//   • the redose preset — the child label's interval/max where it differs from the
//     adult's (#851 item 12).
//
// #798's contract — the dose comes from the child's recorded WEIGHT BAND, confirmed
// against the package — is stated once, by the band picker the switch re-derives inside.
//
// WHAT IT STORES. `intake_items.product`, exactly as today: the curated label for a
// chosen formulation, and nothing for the ingredient's default form (which has no
// label in the dataset to store, and whose row the old full form wrote as empty).
//
// Pure over the dataset entry.

import type { PrnDefaultEntry } from "./datasets/prn-defaults";
import { redoseLabelDefaults } from "./prn-defaults";

// The stable value of the row's default chip — the ingredient's own form, the one the
// dataset states no product label for.
export const DEFAULT_FORMULATION_SLUG = "";

export interface FormulationChoice {
  slug: string;
  label: string;
  // The label to store in `intake_items.product`. Empty for the default chip, which
  // is what the old full form wrote when no formulation was picked.
  product: string;
  pediatric: boolean;
}

// The chip row for an ingredient: its default form first, then the curated pediatric
// products. Empty when the ingredient has no alternative products — a row of one chip
// is a fact nobody needs stated, so the form renders nothing.
export function formulationChoices(
  entry: PrnDefaultEntry | null | undefined
): FormulationChoice[] {
  const formulations = entry?.pediatric?.formulations ?? [];
  if (!entry || formulations.length === 0) return [];
  return [
    {
      slug: DEFAULT_FORMULATION_SLUG,
      // The dataset carries no dosage FORM for the adult tier — only its strength —
      // so the chip states the strength it does know rather than claiming "tablets".
      label: `Adult strength · ${entry.adult.doseMgLow} mg`,
      product: "",
      pediatric: false,
    },
    ...formulations.map((f) => ({
      slug: f.slug,
      label: f.label,
      product: f.label,
      pediatric: true,
    })),
  ];
}

// The default chip for this profile: a child gets the pediatric product, everyone
// else the ingredient's own form. A stored product wins over both — an edit reads
// back what was saved.
export function defaultFormulationSlug(input: {
  choices: readonly FormulationChoice[];
  isChildProfile: boolean;
  storedSlug?: string;
}): string {
  if (input.storedSlug) return input.storedSlug;
  if (!input.isChildProfile) return DEFAULT_FORMULATION_SLUG;
  const pediatric = input.choices.find((c) => c.pediatric);
  return pediatric?.slug ?? DEFAULT_FORMULATION_SLUG;
}

// The redose preset a formulation implies: the child label's figures behind a
// pediatric product, the adult's otherwise. Null when the child label states none —
// #798's refusal to prefill adult numbers below a child's floor.
export function formulationRedosePreset(
  entry: PrnDefaultEntry | null | undefined,
  choice: FormulationChoice | null | undefined
) {
  if (!entry) return null;
  return redoseLabelDefaults(entry, choice?.pediatric === true);
}
