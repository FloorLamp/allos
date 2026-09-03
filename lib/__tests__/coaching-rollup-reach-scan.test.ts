// PURE TIER — the coaching-reach census (#3129), source-scan half.
//
// #3095 gave the dashboard rollup a relevance floor (`review` = 2): a finding
// without an explicit `dashboardRelevance` clears it only on caution/action
// tone. That default is correct for a coaching class with an origin tab of its
// own — its tab is its reach (#449, restated in docs/internals/findings.md) —
// but a class whose ONLY surface is the rollup renders NOWHERE unless its
// producer declares `dashboardRelevance: review` (the mechanism #3095 itself
// established for the five it annotated). #3129 is what one missing
// declaration looks like: the mood observation computed, suppressible,
// documented — and unreachable.
//
// This scan pins the census so the floor can never silently orphan a class
// again:
//
//   1. Every coaching builder aggregated by collectCoachingFindings is
//      classified here, on purpose, as ROLLUP-ONLY or ORIGIN-TAB — a new
//      builder must choose a side (the upcoming-aggregate union precedent).
//   2. Every ROLLUP-ONLY producer's source carries the explicit
//      `dashboardRelevance: FINDING_DASHBOARD_RELEVANCE.review` — red the
//      moment a producer loses its annotation.
//   3. Every ORIGIN-TAB class's claimed surface actually exists and reads the
//      named symbol — the census can't rot into a list of stale excuses.
//
// Proven on the defect: on the pre-#3129 tree, direction 2 fails naming the
// seven orphaned producers (mood, sleep↔mood bridge, sun exposure, oral
// health, paired observations, TTC workup, food–drug variance).

import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { RULE_FINDING_REGISTRY } from "@/lib/rule-finding-prefixes";
import { REPO } from "./sql-scan";

const RULE_FINDINGS = "lib/rule-findings.ts";
const FOOD_DRUG_LEDGER_FINDINGS = "lib/food-drug-ledger-findings.ts";

// The classes whose findings render NOWHERE but the dashboard rollup — no tab,
// page, or widget renders the observation — so their producers MUST declare
// rollup relevance explicitly. The first seven are #3129's restoration; the
// last four are the producers #3095 annotated when it introduced the floor.
// `staleExerciseGroupFinding` is the training-stale GROUP envelope (#3095's
// fifth annotation), a helper inside buildTrainingObservationFindings.
// The sleep clock-skew observation (#4299) is rollup-only for a reason worth
// stating: the Sleep page HEDGES a suspect night's times and offers the delete,
// but it renders no finding envelope, so the rollup is the only place the
// observation itself is reachable.
const ROLLUP_ONLY: ReadonlyArray<{ builder: string; file: string }> = [
  { builder: "buildMoodFindings", file: RULE_FINDINGS },
  { builder: "buildSleepMoodBridgeFindings", file: RULE_FINDINGS },
  { builder: "buildSunExposureFindings", file: RULE_FINDINGS },
  { builder: "buildOralHealthFindings", file: RULE_FINDINGS },
  { builder: "buildPairedObservationFindings", file: RULE_FINDINGS },
  { builder: "buildTtcWorkupFindings", file: RULE_FINDINGS },
  { builder: "buildFoodDrugVarianceFindings", file: FOOD_DRUG_LEDGER_FINDINGS },
  { builder: "buildFitnessCheckFindings", file: RULE_FINDINGS },
  { builder: "buildMedicationDuplicationFindings", file: RULE_FINDINGS },
  { builder: "buildDataQualityFindings", file: RULE_FINDINGS },
  { builder: "buildCycleBleedingFindings", file: RULE_FINDINGS },
  { builder: "buildSleepClockSkewFindings", file: RULE_FINDINGS },
];

const STALE_GROUP_HELPER = "staleExerciseGroupFinding";

// The classes whose observation renders on a domain surface of its own — the
// #3095 design keeps them at the tone-derived default, so the rollup stays
// quiet about what their own tab already shows. Each row names its surface
// file and the symbol that surface reads (the builder itself, or the shared
// computation/formatter the builder maps into the envelope), and the scan
// asserts the reference is real.
const ORIGIN_TAB: ReadonlyArray<{
  builder: string;
  surface: string;
  symbol: string;
}> = [
  {
    builder: "buildTrainingObservationFindings",
    surface: "app/(app)/training/TrainingFindings.tsx",
    symbol: "buildTrainingObservationFindings",
  },
  {
    builder: "buildMuscleVolumeFindings",
    surface: "app/(app)/training/OverviewSection.tsx",
    symbol: "buildMuscleVolumeFindings",
  },
  {
    builder: "buildBodyHygieneFindings",
    surface: "app/(app)/trends/BodyHygieneFindings.tsx",
    symbol: "buildBodyHygieneFindings",
  },
  {
    builder: "buildGoalPacingFindings",
    surface: "app/(app)/training/GoalPacingFindings.tsx",
    symbol: "buildGoalPacingFindings",
  },
  {
    builder: "buildAdherencePatternFindings",
    surface: "app/(app)/nutrition/ManageTab.tsx",
    symbol: "buildAdherencePatternFindings",
  },
  {
    builder: "buildDemotionSuggestionFindings",
    surface: "app/(app)/nutrition/ManageTab.tsx",
    symbol: "buildDemotionSuggestionFindings",
  },
  {
    // The domain pages render the SAME envelope through the exported
    // per-candidate mapper, filtered by the same bus.
    builder: "buildTargetRightSizeFindings",
    surface: "components/RightSizeSuggestions.tsx",
    symbol: "rightSizeCandidateFinding",
  },
  {
    builder: "buildFoodSuggestionFindings",
    surface: "app/(app)/nutrition/FoodTab.tsx",
    symbol: "getFoodSuggestions",
  },
  {
    builder: "buildFoodHabitFindings",
    surface: "app/(app)/nutrition/WeeklyHabits.tsx",
    symbol: "getFrequencyTargetProgress",
  },
  {
    // The substance page renders the finding's exact detail line
    // (capProgressLine over the same week state) with attention styling at or
    // over the cap — the over-target observation is visible on its own surface.
    builder: "buildSubstanceUseFindings",
    surface: "app/(app)/records/SubstanceUseSection.tsx",
    symbol: "capProgressLine",
  },
  {
    builder: "buildProteinAdequacyFindings",
    surface: "app/(app)/nutrition/FoodTab.tsx",
    symbol: "getProteinAdequacy",
  },
  {
    builder: "buildFiberAdequacyFindings",
    surface: "app/(app)/nutrition/FoodTab.tsx",
    symbol: "getFiberAdequacy",
  },
  {
    builder: "buildEndurancePlanFindings",
    surface: "app/(app)/training/OverviewSection.tsx",
    // #3285 widened the Overview's read from getEndurancePlanCards to
    // getEnduranceEvents — the same coached cards, plus the events that have no
    // trajectory. The finding's origin tab still renders the card it links to; the
    // symbol that puts it there is the wider reader now.
    symbol: "getEnduranceEvents",
  },
  {
    // The Training overview renders the same suggestions (title, detail,
    // accept, shared-bus dismiss) straight from the one computation.
    builder: "buildMobilitySuggestionFindings",
    surface: "app/(app)/training/MobilitySection.tsx",
    symbol: "getMobilitySuggestions",
  },
];

const ANNOTATION = "dashboardRelevance: FINDING_DASHBOARD_RELEVANCE.review";

function read(rel: string): string {
  return fs.readFileSync(path.join(REPO, rel), "utf8");
}

// The source of ONE top-level function: from its `function <name>(` line to the
// next top-level `function`/`const` declaration (exported or not). The producer
// files declare every builder at the top level, so this needs no real parser.
function functionSource(src: string, name: string): string {
  const decl = new RegExp(`^(?:export )?function ${name}\\(`, "m");
  const start = src.search(decl);
  expect(start, `function ${name} not found`).toBeGreaterThanOrEqual(0);
  const rest = src.slice(start);
  const next = rest
    .slice(1)
    .search(/^(?:export )?(?:async )?(?:function |const )/m);
  return next < 0 ? rest : rest.slice(0, next + 1);
}

// The coaching builders collectCoachingFindings aggregates, read off the
// registry (its coaching entries whose builder is a plain rule-findings
// function name — the prose entries are the Upcoming/suggestion generators the
// rollup never sees).
function coachingCollectBuilders(): string[] {
  const names = new Set<string>();
  for (const entry of RULE_FINDING_REGISTRY) {
    if (entry.tier !== "coaching") continue;
    if (!/^build\w+$/.test(entry.builder)) continue;
    names.add(entry.builder);
  }
  return [...names].sort();
}

describe("the coaching rollup-reach census is total and enforced (#3129)", () => {
  it("classifies every collectCoachingFindings builder exactly once", () => {
    const classified = [
      ...ROLLUP_ONLY.map((r) => r.builder),
      ...ORIGIN_TAB.map((r) => r.builder),
    ].sort();
    // A builder in both lists would double-count; a registry builder in
    // neither has undeclared reach — both fail here, so a NEW coaching class
    // must choose a side on purpose.
    expect(classified).toEqual(coachingCollectBuilders());
  });

  it("every rollup-only producer declares dashboardRelevance clearing the floor", () => {
    const missing = ROLLUP_ONLY.filter(
      ({ builder, file }) =>
        !functionSource(read(file), builder).includes(ANNOTATION)
    ).map((r) => r.builder);
    expect(missing, `\n${missing.join("\n")}\n`).toEqual([]);
  });

  it("the training-stale group envelope keeps its #3095 annotation", () => {
    expect(functionSource(read(RULE_FINDINGS), STALE_GROUP_HELPER)).toContain(
      ANNOTATION
    );
  });

  it("every origin-tab class's claimed surface really reads the named symbol", () => {
    const broken = ORIGIN_TAB.filter(
      ({ surface, symbol }) => !read(surface).includes(symbol)
    ).map((r) => `${r.builder} → ${r.surface}`);
    expect(broken, `\n${broken.join("\n")}\n`).toEqual([]);
  });

  // The guard must be able to fail (the #1893 fixture rule): a producer that
  // emits info tone with no annotation is exactly what direction 2 flags.
  it("FLAGS a planted producer without the annotation", () => {
    const planted = [
      "export function buildPlantedFindings(): Finding[] {",
      '  return [{ domain: "planted", dedupeKey: "planted:x", title: "t", tone: "info" }];',
      "}",
      "export function other() {}",
    ].join("\n");
    expect(functionSource(planted, "buildPlantedFindings")).not.toContain(
      ANNOTATION
    );
    expect(functionSource(planted, "buildPlantedFindings")).not.toContain(
      "other"
    );
  });
});
