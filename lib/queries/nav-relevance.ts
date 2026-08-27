// The GATHER half of nav relevance gating (issue #1042, phase 1): resolve the
// per-profile relevance bitset the app layout threads once through the shared
// SidebarContent (both viewports for free — the #794 responsive rule). The
// decisions themselves are pure (lib/nav-relevance.ts, unit-tested); this module
// only reads the DB state they need. Cheap by construction — focused EXISTS
// probes plus the profile-settings attribute reads, once per layout render.

import { db, hoistedStatement } from "../db";
import {
  getProfileAge,
  getProfileReproductiveStatus,
  getProfileSex,
} from "../settings/profile-attrs";
import {
  cycleTrackingRelevant,
  specialtyRelevanceForView,
  wellnessTrackingRelevant,
  type NavRelevance,
  type SpecialtyRelevance,
} from "../nav-relevance";
import { isMentalHealthScreeningRelevant, isMinor } from "../life-stage";
import { hasProgressPhotos } from "../progress-photo-write";
import { hasSleepData } from "./sleep";

// The two Specialty DATA probes. Hoisted because #2557 made them a per-profile read
// on a cross-profile surface: the Records shell asks them once for every profile in
// view, on every /records render, which is the hot-path shape AGENTS.md names.
const VISION_ROWS = hoistedStatement(
  `SELECT 1 FROM optical_prescriptions WHERE profile_id = ? LIMIT 1`
);
const DENTAL_ROWS = hoistedStatement(
  `SELECT 1 FROM dental_procedures WHERE profile_id = ? LIMIT 1`
);
const CYCLE_ROWS = hoistedStatement(
  `SELECT 1 FROM cycles WHERE profile_id = ? LIMIT 1`
);

/** Whether a profile has any optical prescription — the Vision pane's data gate. */
function hasVisionRows(profileId: number): boolean {
  return VISION_ROWS.get(profileId) != null;
}

/** Whether a profile has any dental record — the Dental pane's data gate. */
function hasDentalRows(profileId: number): boolean {
  return DENTAL_ROWS.get(profileId) != null;
}

// The relevance bitset for the active profile. Key policy (documented on
// NavRelevance in lib/nav-relevance.ts): Vision/Dental gate on data presence —
// their rows are also created from Data → Import (import-persist writes
// optical_prescriptions/dental_procedures), an always-visible surface, so hiding
// the empty section never strands creation. Since the #1042 final tail these two
// bits gate the folded /records #vision / #dental SECTIONS (their nav leaves are
// gone). Skin and Mental health carry no bit — their /records sections render
// unconditionally because their in-page forms are the only creation path.
export function getNavRelevance(profileId: number): NavRelevance {
  const hasPracticeTargets =
    db
      .prepare(
        `SELECT 1 FROM frequency_targets
         WHERE profile_id = ? AND scope_kind = 'practice'
         LIMIT 1`
      )
      .get(profileId) != null;
  const hasPracticeLogs =
    db
      .prepare(`SELECT 1 FROM practice_logs WHERE profile_id = ? LIMIT 1`)
      .get(profileId) != null;
  return {
    cycle: getCycleTrackingRelevance(profileId),
    vision: hasVisionRows(profileId),
    dental: hasDentalRows(profileId),
    // Data presence only (any recorded sleep session) — the #1066 Sleep nav gate.
    sleep: hasSleepData(profileId),
    // Data presence only (any progress photo) — the #1119 Progress-photos gate.
    progress: hasProgressPhotos(profileId),
    // Either half of the practice store makes its daily home relevant (#1620).
    wellness: wellnessTrackingRelevant({
      hasPracticeTargets,
      hasPracticeLogs,
    }),
  };
}

/** The cycle bit without gathering unrelated navigation domains. */
export function getCycleTrackingRelevance(
  profileId: number,
  age: number | null = getProfileAge(profileId)
): boolean {
  return cycleTrackingRelevant({
    hasCycleRows: CYCLE_ROWS.get(profileId) != null,
    sex: getProfileSex(profileId),
    reproductiveStatus: getProfileReproductiveStatus(profileId),
    age,
  });
}

// The Records › Specialty section-visibility bitset (#1079 + #1174/#1175 + #2807).
// Vision and Dental gate on data presence (from getNavRelevance); Substance use and
// Mental health gate on LIFE STAGE, each at the line its own instruments are validated
// to — AUDIT/DAST are adult-validated so substance use hides for a KNOWN minor, PHQ-9/
// GAD-7 are adolescent-validated so mental health hides only for a KNOWN infant/child.
// Both follow the same positive-match-only policy (unknown age → shown). Computed ONCE
// here so the shared records shell (tab strip), the bare Specialty redirect, and the two
// route re-gates read the SAME predicates (#221 — one question, one computation). Skin
// and Hearing carry no bit (always shown).
export function getRecordsSpecialtyRelevance(
  profileId: number
): SpecialtyRelevance {
  const nav = getNavRelevance(profileId);
  const age = getProfileAge(profileId);
  return {
    vision: nav.vision,
    dental: nav.dental,
    substanceUse: !isMinor(age),
    mentalHealth: isMentalHealthScreeningRelevant(age),
  };
}

// The Specialty pane set for a multi-profile VIEW (#2557). Dental and Vision now read
// every profile in view, so their data-presence gate has to ask the same set the pane
// lists; the life-stage gate stays the acting profile's own. The product decision and
// its reasoning live on the pure fold (specialtyRelevanceForView, lib/nav-relevance.ts)
// — this is only its gather. Single view (`viewIds = [actingProfileId]`) reads exactly
// what getRecordsSpecialtyRelevance returned before.
export function getRecordsSpecialtyRelevanceForView(
  actingProfileId: number,
  viewIds: readonly number[]
): SpecialtyRelevance {
  return specialtyRelevanceForView({
    acting: getRecordsSpecialtyRelevance(actingProfileId),
    // The two DATA probes only — never the whole bitset, which would re-run the
    // cycle/sleep/practice reads once per member for two booleans nobody asked for.
    inView: viewIds.map((id) => ({
      vision: hasVisionRows(id),
      dental: hasDentalRows(id),
    })),
  });
}
