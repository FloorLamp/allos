import { joinNamesForSentence } from "../summarize-names";
import {
  getFoodSuggestions,
  getFrequencyTargetProgress,
  getAllSubstanceWeekStates,
  getIntakeSafetyContext,
  getProteinAdequacy,
  getFiberAdequacy,
} from "../queries";
import { getProfileAge } from "../settings";
import { isMinor } from "../life-stage";
import { frequencyScopeLabel } from "../frequency-targets";
import {
  foodHabitSignalKey,
  isFoodHabitBehind,
  foodHabitInteractions,
  foodHabitInteractionNote,
} from "../food-habit";
import {
  substanceTargetSignalKey,
  capProgressLine,
  substanceDef,
} from "../substance-use";
import {
  proteinAdequacySignalKey,
  proteinAdequacyTitle,
  proteinAdequacyDetail,
  proteinAdequacyEvidence,
} from "../protein";
import {
  fiberAdequacySignalKey,
  fiberAdequacyTitle,
  fiberAdequacyDetail,
  fiberAdequacyEvidence,
} from "../fiber";
import type { Finding } from "../findings";
import { clinicalResultDetailHref } from "../hrefs";
import type { FoodSuggestion } from "../food-suggest";

// ---- Nutrition (#767): goal-scaled protein-adequacy observation ------------

// A calm, coaching-tier observation when this week's protein intake is BELOW the goal-
// scaled band. Reads through getProteinAdequacy — the SAME computation the /nutrition
// adequacy card formats — so the card and this finding can never disagree ("one question,
// one computation"). Coaching tier ONLY (#449): it joins collectCoachingFindings, its
// dedupeKey rides the shared suppression bus (PROTEIN_ADEQUACY_PREFIX is registered in
// RULE_FINDING_PREFIXES), and it NEVER notifies / never reaches the hero. Only the `below`
// verdict surfaces — an estimated basis is a FLOOR, so the copy hedges the shortfall
// (mirroring the #578 RDA-adequacy split) and never asserts a deficiency. No owned SQL is
// added here (reads through the profile-scoped gather).
export function buildProteinAdequacyFindings(profileId: number): Finding[] {
  const a = getProteinAdequacy(profileId);
  if (!a || a.status !== "below") return [];
  return [
    {
      domain: "protein-adequacy",
      dedupeKey: proteinAdequacySignalKey(),
      title: proteinAdequacyTitle(a),
      detail: proteinAdequacyDetail(a),
      // Calm FYI — informational, never an alarm and never a push.
      tone: "info",
      evidence: proteinAdequacyEvidence(a),
      actionHref: "/nutrition",
      actionLabel: "Log servings",
    },
  ];
}

// ---- Nutrition (#976): DRI-scaled fiber-adequacy observation ---------------

// A calm, coaching-tier observation when this week's fiber intake is BELOW the DRI
// adequate-intake target. Reads through getFiberAdequacy — the SAME computation the
// /nutrition fiber-adequacy card formats — so the card and this finding can never disagree
// ("one question, one computation"). Coaching tier ONLY (#449): it joins
// collectCoachingFindings, its dedupeKey rides the shared suppression bus
// (FIBER_ADEQUACY_PREFIX is registered in RULE_FINDING_PREFIXES), and it NEVER notifies /
// never reaches the hero. Only the `below` verdict surfaces — a non-tracked basis is a
// FLOOR, so the copy hedges the shortfall and never asserts a deficiency. No owned SQL is
// added here (reads through the profile-scoped gather).
export function buildFiberAdequacyFindings(profileId: number): Finding[] {
  const a = getFiberAdequacy(profileId);
  if (!a || a.status !== "below") return [];
  return [
    {
      domain: "fiber-adequacy",
      dedupeKey: fiberAdequacySignalKey(),
      title: fiberAdequacyTitle(a),
      detail: fiberAdequacyDetail(a),
      // Calm FYI — informational, never an alarm and never a push.
      tone: "info",
      evidence: fiberAdequacyEvidence(a),
      actionHref: "/nutrition",
      actionLabel: "Log servings",
    },
  ];
}

// ---- Nutrition input (#580): behind-target food-habit observations --------

// One calm coaching finding per tracked food-habit target that's behind this week
// ("2 more servings of fatty fish to hit your weekly habit"). Progress is the shared
// getFrequencyTargetProgress (the #579 rollup, food_group branch) — one computation, no
// parallel count. dedupeKey is keyed on the group slug (food-habit:<slug>). Coaching
// tier only — no notification (the #245 bus-gating precedent would apply if a nudge is
// ever added, out of scope here). No owned SQL added here.
export function buildFoodHabitFindings(profileId: number): Finding[] {
  // Active medications from the ONE shared intake-safety gather (#661), so the "behind
  // this week" encouragement and any food–drug warning come from one computation and
  // can't disagree with the medication row (#661.3).
  const medications = getIntakeSafetyContext(profileId).medications;
  return getFrequencyTargetProgress(profileId)
    .filter(isFoodHabitBehind)
    .map((p) => {
      const label = frequencyScopeLabel("food_group", p.target.scope_value);
      const remaining = p.per_week - p.count;
      const notes = foodHabitInteractions(
        p.target.scope_value,
        medications
      ).map(foodHabitInteractionNote);
      const detail = [
        `${p.count} of ${p.per_week} servings so far — ${remaining} to go to hit your weekly ${label.toLowerCase()} habit.`,
        ...notes,
      ].join(" ");
      return {
        domain: "food-habit",
        dedupeKey: foodHabitSignalKey(p.target.scope_value),
        title: `${label} habit is behind this week`,
        detail,
        tone: "info" as const,
        actionHref: "/nutrition",
        actionLabel: "Log servings",
      };
    });
}

// ---- Substance use (#998/#1078): over-target reduction observations --------

// ONE calm, non-judgmental coaching finding PER SUBSTANCE whose logged units this
// week exceed the profile's own reduction target ("9 drinks logged this week — 2
// over your 7-drink weekly cap."). Iterates the substance catalog (#1078:
// alcohol + nicotine + cannabis) and reads through getAllSubstanceWeekStates —
// the SAME week-window + split-ledger rollup the substance surface renders — and
// formats via the shared capProgressLine, so the page and the finding can never
// disagree ("one question, one computation"). Coaching tier ONLY (#449): it joins
// collectCoachingFindings, each dedupeKey rides the shared suppression bus
// (SUBSTANCE_USE_PREFIX is registered in RULE_FINDING_PREFIXES, keyed per
// substance — #203 stable), and it NEVER notifies / never reaches the hero —
// substance data stays off every push channel. NO GAMIFICATION (#998, the #716
// contract): nothing fires under/at the target — no "on track!" note, no streaks,
// no milestones; silence is the success state. Nothing fires with no target set
// (the observation exists only against the user's OWN goal). No owned SQL added
// here (reads through the profile-scoped query layer).
export function buildSubstanceUseFindings(profileId: number): Finding[] {
  // The substance-use surface is adult-gated (#1174/#1279); never emit a coaching
  // finding that deep-links a known minor to a now-redirected route.
  if (isMinor(getProfileAge(profileId))) return [];
  const out: Finding[] = [];
  for (const state of getAllSubstanceWeekStates(profileId)) {
    if (!state.status || !state.status.over) continue;
    out.push({
      domain: "substance-use",
      dedupeKey: substanceTargetSignalKey(state.substance),
      title: `${substanceDef(state.substance).label} is over your weekly target`,
      detail: capProgressLine(state.status, state.substance),
      // Calm FYI — informational, never an alarm and never a push.
      tone: "info",
      evidence: "Your own weekly reduction target.",
      actionHref: "/records/specialty/substance-use",
      actionLabel: "View intake",
    });
  }
  return out;
}

// ---- Nutrition output (#577): deterministic biomarker→food suggestions ------

// One coaching finding per safety-screened food suggestion. Informational, food-first
// (#576): "Because your … is low, here's a food source." The dedupeKey is family-keyed
// on the nutrient (food-suggest:<key>), so a dismiss covers the nutrient regardless of
// which flagged member is newest (#482). Reads through getFoodSuggestions (the ONE
// computation the biomarker detail page also formats), so a finding and the page card
// can never disagree ("one question, one computation"). No owned SQL here.
export function buildFoodSuggestionFindings(profileId: number): Finding[] {
  return getFoodSuggestions(profileId).map(foodSuggestionToFinding);
}

function foodSuggestionToFinding(s: FoodSuggestion): Finding {
  const reduce = s.direction === "reduce";
  const because =
    s.triggeredBy.length > 0
      ? // The trigger side rides on the suggestion (#2754): the soluble-fiber ADD is
        // high-triggered, so the side may not be derived from the verb. The NAMES
        // are joined by the shared rule, never by a comma — a lab name carries its
        // own ("Lymphocytes, Relative"), and a comma join makes two triggers read
        // as four (#3496; docs/internals/copy.md §9).
        `Because your ${joinNamesForSentence(s.triggeredBy)} ${s.triggeredBy.length > 1 ? "are" : "is"} ${s.side}`
      : reduce
        ? "Foods to reduce"
        : "Food sources";
  const foodLine = s.foods.map((f) => `${f.food} — ${f.serving}`).join(" ");
  const cautions = s.safetyNotes.map((n) => n.text);
  const detail = [because + ".", foodLine, ...cautions, s.caveat]
    .filter(Boolean)
    .join(" ");
  return {
    domain: "food-suggest",
    dedupeKey: s.dedupeKey,
    // Add vs reduce framing (#775): "Food for …" (eat more) vs "Cut back for …".
    title: reduce ? `Cut back for ${s.label}` : `Food for ${s.label}`,
    detail,
    // Calm, informational lifestyle guidance — never a red attention flag; the reduce
    // direction is coaching-tier too (#449), never a push/hero.
    tone: "info",
    evidence: `${s.evidence} Source: ${s.source}.`,
    actionHref: clinicalResultDetailHref(s.triggeredBy[0] ?? null),
    actionLabel: "View biomarker",
  };
}
