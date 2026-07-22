// The GATHER half of nav relevance gating (issue #1042, phase 1): resolve the
// per-profile relevance bitset the app layout threads once through the shared
// SidebarContent (both viewports for free — the #794 responsive rule). The
// decisions themselves are pure (lib/nav-relevance.ts, unit-tested); this module
// only reads the DB state they need. Cheap by construction — three EXISTS probes
// plus the profile-settings attribute reads, once per layout render.

import { db } from "../db";
import {
  getUserAge,
  getUserReproductiveStatus,
  getUserSex,
} from "../settings/profile-attrs";
import { cycleTrackingRelevant, type NavRelevance } from "../nav-relevance";
import { isMinor } from "../life-stage";
import { hasSleepData } from "./sleep";

// The relevance bitset for the active profile. Key policy (documented on
// NavRelevance in lib/nav-relevance.ts): Vision/Dental gate on data presence —
// their rows are also created from Data → Import (import-persist writes
// optical_prescriptions/dental_procedures), an always-visible surface, so hiding
// the empty section never strands creation. Since the #1042 final tail these two
// bits gate the folded /records #vision / #dental SECTIONS (their nav leaves are
// gone). Skin and Mental health carry no bit — their /records sections render
// unconditionally because their in-page forms are the only creation path.
export function getNavRelevance(profileId: number): NavRelevance {
  const hasCycleRows =
    db
      .prepare(`SELECT 1 FROM cycles WHERE profile_id = ? LIMIT 1`)
      .get(profileId) != null;
  const hasVisionRows =
    db
      .prepare(
        `SELECT 1 FROM optical_prescriptions WHERE profile_id = ? LIMIT 1`
      )
      .get(profileId) != null;
  const hasDentalRows =
    db
      .prepare(`SELECT 1 FROM dental_procedures WHERE profile_id = ? LIMIT 1`)
      .get(profileId) != null;
  return {
    cycle: cycleTrackingRelevant({
      hasCycleRows,
      sex: getUserSex(profileId),
      reproductiveStatus: getUserReproductiveStatus(profileId),
      age: getUserAge(profileId),
    }),
    vision: hasVisionRows,
    dental: hasDentalRows,
    // Data presence only (any recorded sleep session) — the #1066 Sleep nav gate.
    sleep: hasSleepData(profileId),
  };
}

// The Records › Specialty section-visibility bitset (#1079 + #1174/#1175). Vision
// and Dental gate on data presence (from getNavRelevance); Substance use gates on
// LIFE STAGE — its AUDIT/DAST instruments are adult-validated, so it hides for a
// KNOWN minor (adult OR unknown age → shown, matching isMinor's positive-match-only
// policy). Computed ONCE here so the shared records shell (tab strip), the bare
// Specialty redirect, and the substance-use route re-gate all read the SAME predicate
// (#221 — one question, one computation). Mental health/Skin carry no bit (always
// shown); Mental health is deliberately NOT life-stage gated (adolescent-validated).
export function getRecordsSpecialtyRelevance(profileId: number): {
  vision: boolean;
  dental: boolean;
  substanceUse: boolean;
} {
  const nav = getNavRelevance(profileId);
  return {
    vision: nav.vision,
    dental: nav.dental,
    substanceUse: !isMinor(getUserAge(profileId)),
  };
}
