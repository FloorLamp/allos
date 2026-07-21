// The reserved pseudo-group for the protein "+Xg" food-nudge button (issue #1073).
//
// `__protein__` rides the EXISTING food_log_events ledger + blendFoodOrder ranking (#950)
// so the protein button self-surfaces in the slots the profile actually logs protein
// (post-workout evening) and recedes where they don't (breakfast) — no gating rule, pure
// habit ranking. It is a RANKING PARTICIPANT ONLY. The load-bearing correctness is the
// reserved-key discipline: `__protein__` is EXCLUDED from every food-GROUP code path —
//   • the catalog (FOOD_GROUPS / foodGroupSlugs): it's not in the dataset JSON, and
//     canonicalFoodGroup() rejects it, so a forged food-log token for it lands nothing;
//   • the food_log day counter + the serving tally line (its contribution is the day's
//     protein GRAMS, shown on its own line, never mixed into "✓ Today: Leafy greens ×2");
//   • dietary-exclusion demotion (#975) and any group-semantics — it has no group.
// The double-underscore form cannot collide with a catalog slug (snake_case, no leading
// underscore). Pure — no DB/network — so the guard tests live in the pure tier.

// The reserved key written to food_log_events (never to food_log) for a protein log.
export const PROTEIN_NUDGE_KEY = "__protein__";

// True for the reserved protein pseudo-group key. The one predicate every food-group
// path calls to hold the key out of group semantics (catalog resolution, the tally line).
export function isProteinNudgeKey(key: string): boolean {
  return key === PROTEIN_NUDGE_KEY;
}

// The grams offered before the profile has a saved quick-add scoop preset (#824) — a
// typical scoop, used only at cold start; the last-used preset wins once one exists.
export const DEFAULT_PROTEIN_PRESET_GRAMS = 30;

// The "+Xg protein" button label — the grams preset, deliberately distinct from a
// food-group name so it reads as the shake path, not a serving.
export function proteinNudgeButtonLabel(grams: number): string {
  return `＋${grams}g protein`;
}
