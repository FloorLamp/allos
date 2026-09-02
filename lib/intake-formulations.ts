// The formulation chip row of the one intake form (#3216, owner decision 2).
//
// THE FACT IT SURFACES. One ingredient is several products. Ibuprofen is an adult
// tablet at one strength and a children's oral suspension at another, and the #798
// datasets already carry the concentrations — but only the pediatric band picker,
// buried inside the dose block, ever offered the choice. As a derived chip row beside
// the kind chip, the choice is where the person can see it, and the profile's age
// picks the default rather than making them find it.
//
// WHAT A SWITCH RE-DERIVES, and why each follows from the product rather than from
// the person:
//   • the dose amount — a suspension's dose is a volume, so the amount carries both
//     the milligrams and the millilitres;
//   • the redose preset — the child label's interval/max where it differs from the
//     adult's (#851 item 12);
//   • the pediatric context — #798's contract that the dose comes from the child's
//     recorded WEIGHT BAND and is confirmed against the package, which survives the
//     switch rather than being re-derived away by it.
//
// WHAT IT STORES. `intake_items.product`, exactly as today: the curated label for a
// chosen formulation, and nothing for the ingredient's default form (which has no
// label in the dataset to store, and whose row the old full form wrote as empty).
//
// Pure over the dataset entry.

import type { PrnDefaultEntry } from "./datasets/prn-defaults";
import { PEDIATRIC_DOSE_CAVEAT } from "./prn-dosing";
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

// The dose amount a formulation implies for a given milligram figure.
//
// THE VOLUME IS NOT STORED HERE, and that is the whole decision. #3216 asks a
// formulation switch to re-derive the dose "volume-first with strength equivalence",
// and a suspension's dose really is a volume — but the volume is already DERIVED at
// every display boundary by `formatMedicationDoseProduct`, which scales the product's
// concentration to the selected milligrams and renders "240 mg / 7.5 mL". So the
// switch re-derives `product`, and the amount stays milligrams.
//
// WHAT A VOLUME-LEADING AMOUNT WOULD COST. `parseAmountMg` (#1854) is anchored at a
// leading number + mass unit, so it reads "240 mg / 7.5 mL" perfectly well — an
// mg-leading string with the volume appended is NOT the hazard. The hazard is the
// literal reading of "volume-first": "7.5 mL (240 mg)" and "7.5 mL" both parse to
// null. And `prnDayExposure` treats an unreadable amount as a reason to abandon the
// milligram basis — `PrnExposureBasis` flips from "mg" to "count", so a confirmed
// mg/day ceiling silently stops being a mg/day ceiling and becomes a dose count.
// That would land on a child's liquid medicine, which is the single case where the
// milligram ceiling matters most (200 mg and 800 mg of the same ingredient are the
// same "dose" and four times the exposure). Nothing surfaces the downgrade.
//
// Storing BOTH would also put one datum in two columns, free to drift the moment
// someone edits one, and make `formatMedicationDoseProduct` render the concentration
// twice ("240 mg / 7.5 mL · 160 mg / 5 mL").
//
// The band PICKER still shows the volume beside each band — there it is a label the
// person reads before measuring, not a value the row stores.
export function formulationDoseAmount(mg: number): string {
  return `${mg} mg`;
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

// The #798 contract line that rides a pediatric formulation: the dose is the child's
// recorded WEIGHT BAND, and it is confirmed against the package — never a computed
// mg/kg. It survives a formulation switch because it is a property of dosing a child,
// not of the product chosen.
export function pediatricContextLine(
  choice: FormulationChoice | null | undefined,
  isChildProfile: boolean
): string | null {
  if (!isChildProfile && !choice?.pediatric) return null;
  return `The dose is by the child's weight band. ${PEDIATRIC_DOSE_CAVEAT}`;
}
