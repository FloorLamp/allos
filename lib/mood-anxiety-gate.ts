// Relevance gate for the check-in "Calm" (anxiety) scale (issue #1313). The Calm
// 1–5 scale is a dead fifth scale for a profile not engaging with the mental-health
// domain; its real value is the CONTINUOUS signal between sparse clinical snapshots
// (a daily rating tracking treatment response between GAD-7 administrations, or a
// meditation-protocol outcome, #1259). So it is gated to profiles with a signal —
// the same idiom the nav already uses (lib/nav-relevance.ts): a PURE decision, the
// DB gather lives in lib/queries/mood-anxiety.ts.
//
// SENSITIVITY (the #716 LAW applies, restated on the gate):
//   • The gate is SILENT — the scale appears or doesn't; NO copy ever names the
//     trigger ("because you take sertraline" must never render, on any surface).
//   • The inference is a DISPLAY BIT, not a stored label — nothing writes
//     "mental-health-relevant" anywhere; the bit is derived per render, never
//     exported or logged.
//   • Existing anxiety data keeps rendering in history regardless of the gate
//     (display of what was logged is never gated) — this module gates the SCALE
//     (the input surface), never the stored values.
//
// Everything here is DB-free so the OR matrix + the keyword/CUI matchers are fully
// unit-tested in lib/__tests__/mood-anxiety-gate.test.ts.

import { itemRxcuis } from "./drug-interactions";

// Signal 2/5 anchor: the anxiety/depression instruments (#716) stored biomarker-
// shaped under these canonical names. A GAD-7 or PHQ-9 record on file means the
// profile is tracking the domain the daily Calm rating fills between.
export const ANXIETY_INSTRUMENT_CANONICAL = ["GAD-7", "PHQ-9"] as const;

// Signal 5 anchor: a protocol (#1259) whose primary outcome IS the anxiety series
// declares one of these outcome keys (the instruments are biomarker-shaped, so the
// N-of-1 outcome vocabulary names them "biomarker:GAD-7"/"biomarker:PHQ-9").
export const ANXIETY_PROTOCOL_OUTCOME_KEYS = [
  "biomarker:GAD-7",
  "biomarker:PHQ-9",
] as const;

// Signal 3: a curated anxiety/mood keyword set matched (substring, case-folded) over
// active CONDITION names — the CLINICAL_SITUATIONS keyword-table shape (lib/situations
// .ts). Conservative: an unrecognized condition matches nothing rather than guessing.
export const ANXIETY_CONDITION_KEYWORDS: readonly string[] = [
  "anxiety",
  "gad",
  "generalized anxiety",
  "panic",
  "phobia",
  "agoraphobia",
  "ptsd",
  "post-traumatic",
  "posttraumatic",
  "ocd",
  "obsessive-compulsive",
  "obsessive compulsive",
  "depression",
  "depressive",
  "mdd",
  "dysthymia",
  "bipolar",
];

// Signal 4: a curated anxiolytic/antidepressant INGREDIENT RxCUI set, matched against
// each active med's cached RxCUIs (issue #144's mechanism reused — RxCUI-authoritative,
// NEVER name-string matching, per the issue). RxNorm ingredient-level RxCUIs for the
// common SSRIs/SNRIs, benzodiazepines, buspirone, and hydroxyzine.
export const ANXIOLYTIC_INGREDIENT_CUIS: ReadonlySet<string> = new Set([
  "36437", // sertraline
  "321988", // escitalopram
  "2556", // citalopram
  "4493", // fluoxetine
  "32937", // paroxetine
  "39786", // venlafaxine
  "72625", // duloxetine
  "42347", // bupropion
  "1827", // buspirone
  "596", // alprazolam
  "6470", // lorazepam
  "2598", // clonazepam
  "3322", // diazepam
  "5553", // hydroxyzine
]);

// Whether any active CONDITION name matches the anxiety/mood keyword set (signal 3).
export function conditionMatchesAnxiety(names: readonly string[]): boolean {
  return names.some((name) => {
    const n = name.toLowerCase();
    return ANXIETY_CONDITION_KEYWORDS.some((k) => n.includes(k));
  });
}

// The minimal med shape signal 4 needs: the cached RxCUIs (product-level + active
// ingredients, #279). Name is IRRELEVANT to the match by design (RxCUI-only), so a
// med with no resolved CUI simply doesn't contribute an anxiety signal.
export interface AnxietyMedInput {
  rxcui: string | null;
  rxcuiIngredients?: string[] | null;
}

// Whether any active MEDICATION resolves (by RxCUI) to a curated anxiolytic/
// antidepressant ingredient (signal 4). Uses the shared itemRxcuis (#144/#279) so a
// combination product matches through each of its ingredient CUIs.
export function medMatchesAnxiety(meds: readonly AnxietyMedInput[]): boolean {
  return meds.some((med) => {
    for (const cui of itemRxcuis(med)) {
      if (ANXIOLYTIC_INGREDIENT_CUIS.has(cui)) return true;
    }
    return false;
  });
}

// The six OR'd inputs. Signals 1/2/5/6 arrive as resolved booleans (the DB gather
// computes them); signals 3/4 arrive as the raw active-condition names / active-med
// CUIs so the curated matchers stay pure and independently tested.
export interface AnxietyGateSignals {
  // 1. Prior use: any prior anxiety rating on record — continuity trumps inference,
  //    so nobody loses a data-entry surface they've used.
  priorUse: boolean;
  // 2. Instrument on record: a GAD-7 or PHQ-9 medical_records row (#716).
  instrumentOnRecord: boolean;
  // 3. Active condition names (curated-keyword matched here).
  activeConditionNames: readonly string[];
  // 4. Active medications with their cached RxCUIs (curated-CUI matched here).
  activeMeds: readonly AnxietyMedInput[];
  // 5. Protocol outcome: an ongoing protocol whose primary outcome is the anxiety
  //    series (#1259).
  anxietyProtocolOutcome: boolean;
  // 6. Explicit opt-in: the Settings → Profile toggle — the escape hatch for a
  //    profile with no inferable signal.
  optIn: boolean;
}

// Resolve the gate: OR of the six signals. Each input alone flips it true; none →
// hidden; the opt-in is just another OR member (it can only ADD the scale, never
// remove it — prior use always keeps it, per signal 1).
//
// (The #1313 axis relabel lives in lib/mood.ts — anxietyDisplaySlot/anxietyStored
// Value — so the client check-in card imports it without pulling this module's
// drug-dataset dependency.)
export function anxietyScaleRelevant(signals: AnxietyGateSignals): boolean {
  return (
    signals.priorUse ||
    signals.instrumentOnRecord ||
    conditionMatchesAnxiety(signals.activeConditionNames) ||
    medMatchesAnxiety(signals.activeMeds) ||
    signals.anxietyProtocolOutcome ||
    signals.optIn
  );
}
