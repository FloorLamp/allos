// THE GI EFFECT VOCABULARY, shared by everything that reads a gut effect (#5865).
//
// Two surfaces name the same set of GI outcomes and neither may drift from the other:
// the fiber × GI panel marks the days these were logged on (lib/fiber-symptom-panel.ts,
// #2788/#2785/#2783), and a declared food sensitivity states one of them as the effect
// it expects (`food_sensitivities.effect`). The list was the panel's own until this
// module; a second reader is exactly the moment a private list becomes a vocabulary.
//
// A DECLARED LIST, NOT A DOMAIN FILTER. `SymptomDomain` is an order-only lever by its
// own contract — `bloating` sits under `cycle` — so filtering the curated catalog by it
// would cut against that contract AND miss members. The four symptom slugs below are
// therefore named one at a time; the panel's test pins that every one of them still
// resolves to a curated symptom slug, so a vocabulary rename cannot silently drop one.
//
// THE STOOL EFFECT IS NOT A SYMPTOM AND DOES NOT PRETEND TO BE. "Loose stools" is a
// Bristol 6–7 observation in `metric_samples` (lib/bristol-stool.ts) — one sample per
// event, counted and never averaged — while the other four are day-grain
// `symptom_logs` rows with a severity. One list, two stores, and `source` is what tells
// a reader which one it must go to. Fusing them into one enum without that marker is
// how a reader ends up asking the symptom table for a Bristol type.
//
// Pure: no React, no DB, no clock. The labels come from the curated symptom catalog
// rather than being retyped here, so the chip in the sensitivity form and the marker in
// the panel say the same word as the symptom log itself.

import { symptomBySlug } from "./symptoms";

/** Which store holds the observation an effect is read from. */
export type GiEffectSource = "symptom" | "stool";

export interface GiEffect {
  /** Stored value of `food_sensitivities.effect`. Lowercase snake_case, never renamed. */
  slug: string;
  /** Display name — the chip, the catalog row, the panel's marker. */
  label: string;
  source: GiEffectSource;
}

/**
 * The GI subset of the symptom vocabulary. Day-grain `symptom_logs` rows with a
 * severity; the fiber panel marks the days they were logged on.
 */
export const GI_SYMPTOM_EFFECTS: readonly string[] = [
  "diarrhea",
  // Constipation (#2783) — without it the panel marked one direction of dysfunction
  // only, so a fiber rise that traded constipation for looser stools read as GI symptom
  // days APPEARING out of nowhere.
  "constipation",
  "bloating",
  "abdominal_pain",
];

/** The effect slug for a loose stool. Not a symptom slug — see `source` above. */
export const LOOSE_STOOLS_EFFECT = "loose_stools";

/**
 * The Bristol type at which a stool counts as loose (#2785). 6 (mushy) and 7 (liquid);
 * 5 is "soft blobs, passed easily", which is a normal stool and not an effect.
 */
export const LOOSE_STOOL_MIN_TYPE = 6;

/** Whether a Bristol type counts as a loose stool. */
export function isLooseStoolType(type: number): boolean {
  return type >= LOOSE_STOOL_MIN_TYPE;
}

/**
 * Every effect a sensitivity may name, in the order a chooser lists them. The stool
 * effect leads: it is the one the owner idea named, and the only one with a count
 * rather than a severity.
 */
export const GI_EFFECTS: readonly GiEffect[] = [
  { slug: LOOSE_STOOLS_EFFECT, label: "Loose stools", source: "stool" },
  ...GI_SYMPTOM_EFFECTS.map((slug) => ({
    slug,
    // The curated catalog's own word (lib/symptoms.json), never retyped. A slug with no
    // catalog entry falls back to itself rather than rendering "undefined" — and the
    // panel's test is what stops that fallback from ever being reached.
    label: symptomBySlug(slug)?.label ?? slug,
    source: "symptom" as const,
  })),
];

const BY_SLUG = new Map(GI_EFFECTS.map((e) => [e.slug, e]));

export function giEffectBySlug(slug: string): GiEffect | undefined {
  return BY_SLUG.get(slug);
}

/** Whether a stored string is a member of this vocabulary. */
export function isGiEffect(slug: string): boolean {
  return BY_SLUG.has(slug);
}
