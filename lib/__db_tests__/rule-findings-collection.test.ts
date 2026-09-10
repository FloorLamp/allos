// DB INTEGRATION TIER — the collected coaching corpus, pinned byte for byte (#2962).
//
// WHY A CORPUS AND NOT A SET OF CASES. #2962 splits the twenty-odd domain builders out
// of lib/rule-findings.ts into owning modules behind one collection registry, and its
// load-bearing acceptance criterion is that "finding keys, episode anchors,
// `supersedes`, suppression behaviour, closure snapshots, priority and copy are
// unchanged". No reviewer can verify that by reading a diff that relocates twenty
// builders. So the whole collected output for the seeded personas is captured here as
// data and compared exactly, and the relocation is checkable in one run.
//
// This is the registry's own test, in the split's terms: it asserts COLLECTION
// behaviour — the envelope, the deterministic order, suppression/dismissal, and the
// closure snapshot — over every domain at once. Per-builder behaviour (thresholds,
// copy decisions, exclusions) belongs to each owning module's spec and is deliberately
// not restated here: a claim asserted at two layers is not twice the coverage, it is
// one claim with two places to drift.
//
// EXACT EQUALITY, NEVER A SUBSET, the discipline the query-budget gates state at
// length. The recorded file is regenerated deliberately, never bumped to make a run
// green:
//
//   RULE_FINDINGS_CAPTURE=1 npm run test:db -- rule-findings-collection
//
// and the regenerated diff is then the change's own evidence about which finding moved.
//
// THE CLOCK IS PINNED HERE, not left to the tier freeze, and that is the reason the
// corpus can be byte-stable at all: dedupe keys embed dates (the fitness-check's last
// check, the weight anomaly's day), episode anchors embed the year, and copy embeds
// formatted dates. The tier's freeze follows the real day, so an unpinned run would
// rewrite this file every midnight. Same instant, and same reason, as the tick and
// route budget gates.

import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { db, today } from "@/lib/db";
import { dismissFinding, getFindingSuppressions } from "@/lib/queries";
import { activeFindings } from "@/lib/findings";
import { DATA_QUALITY_PREFIX } from "@/lib/data-quality";
import { FITNESS_CHECK_PREFIX } from "@/lib/fitness-retest";
import {
  buildActivePlateauHints,
  buildAdherencePatternFindings,
  buildBodyHygieneFindings,
  buildCycleBleedingFindings,
  buildDataQualityFindings,
  buildDemotionSuggestionFindings,
  buildEndurancePlanFindings,
  buildFiberAdequacyFindings,
  buildFitnessCheckFindings,
  buildFoodHabitFindings,
  buildFoodSuggestionFindings,
  buildGoalPacingFindings,
  buildMedicationDuplicationFindings,
  buildMobilitySuggestionFindings,
  buildMoodFindings,
  buildMuscleVolumeFindings,
  buildOralHealthFindings,
  buildPairedObservationFindings,
  buildProteinAdequacyFindings,
  buildSleepClockSkewFindings,
  buildSleepMoodBridgeFindings,
  buildSubstanceUseFindings,
  buildSunExposureFindings,
  buildTargetRightSizeFindings,
  buildTrainingObservationFindings,
  buildTtcWorkupFindings,
  closureFindingSnapshot,
  COACHING_COLLECTION,
  COACHING_ENTITY_FINDING_LIMITS,
  collectCoachingFindings,
  collectDataQualityGaps,
  collectRightSizeCandidates,
  demotionCandidateItemIds,
  rightSizeCandidateFinding,
} from "@/lib/rule-findings";
import { PERSONAS } from "../../scripts/seed-personas";
import { personaContextFor } from "@/lib/__db_tests__/persona-fixture";

const PINNED_INSTANT = new Date("2026-08-18T13:00:00.000Z");
const CAPTURE = path.join(
  import.meta.dirname,
  "rule-findings-collection.capture.json"
);

// A second display shape, so the two arguments that thread into copy but must never
// reach a dedupeKey (#1019 weights, #1020 dates) are both exercised by the corpus.
const ALT_PREFS = { timeFormat: "24h", dateFormat: "dmy" } as const;

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// One persona's whole reachable surface of lib/rule-findings: the collection in its
// declared order, both display shapes, the closure snapshot per declared prefix, and
// each collection-adjacent reader that does not travel through it.
// Every builder, called directly, in the collection's own order. An empty result is
// recorded too: this is the half of the corpus that is total over the builders rather
// than over the data, so a builder the personas never trigger still has its output — and
// its default arguments — pinned by name.
function eachBuilder(profileId: number, day: string) {
  return {
    buildMedicationDuplicationFindings:
      buildMedicationDuplicationFindings(profileId),
    buildTrainingObservationFindings: buildTrainingObservationFindings(
      profileId,
      day
    ),
    buildMuscleVolumeFindings: buildMuscleVolumeFindings(profileId, day),
    buildBodyHygieneFindings: buildBodyHygieneFindings(profileId, day, "kg"),
    buildGoalPacingFindings: buildGoalPacingFindings(profileId, day),
    buildAdherencePatternFindings: buildAdherencePatternFindings(
      profileId,
      day
    ),
    buildDemotionSuggestionFindings: buildDemotionSuggestionFindings(
      profileId,
      day
    ),
    buildTargetRightSizeFindings: buildTargetRightSizeFindings(profileId, day),
    buildFoodSuggestionFindings: buildFoodSuggestionFindings(profileId),
    buildFoodHabitFindings: buildFoodHabitFindings(profileId),
    buildSubstanceUseFindings: buildSubstanceUseFindings(profileId),
    buildProteinAdequacyFindings: buildProteinAdequacyFindings(profileId),
    buildFiberAdequacyFindings: buildFiberAdequacyFindings(profileId),
    buildEndurancePlanFindings: buildEndurancePlanFindings(profileId, day),
    buildSunExposureFindings: buildSunExposureFindings(profileId, day),
    buildOralHealthFindings: buildOralHealthFindings(profileId),
    buildFitnessCheckFindings: buildFitnessCheckFindings(profileId, day),
    buildMobilitySuggestionFindings: buildMobilitySuggestionFindings(
      profileId,
      day
    ),
    buildMoodFindings: buildMoodFindings(profileId, day),
    buildSleepMoodBridgeFindings: buildSleepMoodBridgeFindings(profileId, day),
    buildSleepClockSkewFindings: buildSleepClockSkewFindings(profileId, day),
    buildPairedObservationFindings: buildPairedObservationFindings(
      profileId,
      day
    ),
    buildCycleBleedingFindings: buildCycleBleedingFindings(profileId, day),
    buildTtcWorkupFindings: buildTtcWorkupFindings(profileId, day),
    buildDataQualityFindings: buildDataQualityFindings(profileId),
  };
}

function capture(profileId: number) {
  const day = today(profileId);
  const coaching = collectCoachingFindings(profileId, day, "kg");
  return {
    today: day,
    coaching,
    builders: eachBuilder(profileId, day),
    coachingAltDisplay: collectCoachingFindings(
      profileId,
      day,
      "lb",
      ALT_PREFS
    ),
    closure: {
      fitnessCheck: closureFindingSnapshot(
        profileId,
        [FITNESS_CHECK_PREFIX],
        day
      ),
      dataQuality: closureFindingSnapshot(
        profileId,
        [DATA_QUALITY_PREFIX],
        day
      ),
      both: closureFindingSnapshot(
        profileId,
        [FITNESS_CHECK_PREFIX, DATA_QUALITY_PREFIX],
        day
      ),
      unknownPrefix: closureFindingSnapshot(
        profileId,
        ["no-such-prefix:"],
        day
      ),
    },
    dataQualityGaps: collectDataQualityGaps(profileId),
    plateauHints: buildActivePlateauHints(profileId, day),
    rightSizeCandidates: collectRightSizeCandidates(profileId, day),
    rightSizeFindings: collectRightSizeCandidates(profileId, day).map(
      rightSizeCandidateFinding
    ),
    demotionCandidateItemIds: [...demotionCandidateItemIds(profileId, day)],
    // Dismissal, taken over the collection's OWN keys and read back through the shared
    // bus: what survives is the suppression semantics the split must preserve, and the
    // `supersedes` dual-read (#436) is what makes the survivors interesting.
    afterDismissingEveryKey: (() => {
      for (const f of coaching) dismissFinding(profileId, f.dedupeKey);
      return activeFindings(
        collectCoachingFindings(profileId, day, "kg"),
        getFindingSuppressions(profileId),
        day
      );
    })(),
  };
}

let corpus = "";

describe("the collected coaching corpus is unchanged (#2962)", () => {
  beforeAll(() => {
    vi.setSystemTime(PINNED_INSTANT);
    // The fan-out caps ride in the corpus: they are applied per family BEFORE shared
    // suppression, and that ordering is a collection contract, not a builder detail.
    const out: Record<string, unknown> = {
      // The declared collection order, recorded for ALL of it rather than only for the
      // domains the seeded population happens to trigger. This is the one part of the
      // split a reviewer CAN check by reading: it diffs against the concatenation
      // collectCoachingFindings used before the builders moved.
      collectionOrder: COACHING_COLLECTION.map((entry) => entry.builder),
      // The fan-out caps ride in the corpus: they are applied per family BEFORE shared
      // suppression, and that ordering is a collection contract, not a builder detail.
      entityFindingLimits: COACHING_ENTITY_FINDING_LIMITS,
    };
    for (const persona of PERSONAS) {
      const profileId = newProfile(`findings:${persona.name}`);
      persona.apply(personaContextFor(profileId));
      out[persona.name] = capture(profileId);
    }
    corpus = `${JSON.stringify(out, null, 2)}\n`;
    if (process.env.RULE_FINDINGS_CAPTURE) fs.writeFileSync(CAPTURE, corpus);
  }, 600_000);

  it("matches the recorded capture byte for byte", () => {
    expect(corpus).toBe(fs.readFileSync(CAPTURE, "utf8"));
  });

  // The corpus is only as honest as the population it was taken over: a capture that
  // happened to collect nothing would compare equal to itself forever.
  it("collects findings across the personas it was captured over", () => {
    const {
      collectionOrder: _order,
      entityFindingLimits: _limits,
      ...recorded
    } = JSON.parse(corpus) as Record<
      string,
      { coaching: { domain: string }[] }
    >;
    expect(Object.keys(recorded)).toEqual(PERSONAS.map((p) => p.name));
    const domains = new Set<string>();
    for (const p of Object.values(recorded))
      for (const f of p.coaching) domains.add(f.domain);
    expect(domains.size).toBeGreaterThan(5);
  });
});
