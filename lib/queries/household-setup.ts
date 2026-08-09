// Per-member SETUP HEALTH — the DB gather behind the pure model in
// lib/household-setup.ts (issue #2173). Every check is DERIVED AT READ TIME: there is no
// stored state, no new engine and no new table. Granting a login access, configuring a
// channel, adding a dose or starting onboarding clears its line BY CONSTRUCTION.
//
// NO NEW SQL LIVES HERE ON PURPOSE. Each fact is asked through the reader its own domain
// already owns — `getSupplements` / `getSupplementDoses` for the roster,
// `getOnboardingState` + `getOnboardingDataPresence` for onboarding,
// `assessProfilePreventive` + `kindedScheduled` + `getFindingSuppressions` for the
// preventive planner's own outstanding set, `getNotifySchedule` + `inferWorkoutSchedule`
// for the send sources, `profileRoutingFacts` for the edge set. So every statement behind
// this module is already profile-scoped, and the checks cannot disagree with the surfaces
// they are reporting on.
//
// SCOPE. These are per-profile reads. The `/household` page composes them per member over
// the already-authorized accessible set it resolved once — nothing here bypasses that gate
// or evaluates a member the login cannot reach. Auth-blind, `profileId` first, like every
// other reader in this layer.

import { cache } from "../request-cache";
import {
  detectHouseholdSetup,
  unroutable,
  type HouseholdSetupFacts,
  type HouseholdSetupRow,
  type SendSourceFacts,
  type SetupIntakeItem,
  type SetupPreventiveItem,
  type UnroutableReason,
} from "../household-setup";
import { isPushedIntake } from "../supplement-schedule";
import { getOnboardingDataPresence } from "../onboarding-data";
import { getOnboardingState, getNotifySchedule } from "../settings";
import { profileRoutingFacts } from "../notifications/routing";
import { getSupplements, getSupplementDoses } from "./intake/schedule";
import { inferWorkoutSchedule } from "./training/activities";
import { kindedScheduled } from "./appointments";
import { scheduledMatchForRule } from "../preventive-appointment";
import { preventiveSignalKey } from "../preventive-upcoming";
import { isSuppressed } from "../upcoming-suppress";
import { assessProfilePreventive, getFindingSuppressions } from "./upcoming";

// ── Send sources ──────────────────────────────────────────────────────────────

// The tick's own gates, asked as a question about the PROFILE rather than about this
// minute. Timezone-free: nothing here consults a clock, because the condition is
// structural.
function gatherSendSources(
  profileId: number,
  preventiveNudges: number
): SendSourceFacts {
  const sched = getNotifySchedule(profileId);
  const anyIntakeWindow = Object.values(sched.supplementMinutes).some(
    (m) => m != null
  );
  const dosedItemIds = new Set(
    getSupplementDoses(profileId).map((d) => d.item_id)
  );
  let scheduledMedications = 0;
  let scheduledSupplements = 0;
  if (anyIntakeWindow) {
    for (const item of getSupplements(profileId)) {
      if (!item.active || !isPushedIntake(item)) continue;
      if (!dosedItemIds.has(item.id)) continue;
      if (item.kind === "medication") scheduledMedications++;
      else scheduledSupplements++;
    }
  }
  return {
    scheduledMedications,
    scheduledSupplements,
    digestEnabled: sched.digestMinute != null,
    weeklyRecapEnabled: sched.weeklyRecapDay != null,
    // `workoutEnabled` is default-ON, so the flag alone would make every profile a send
    // source and "quiet, correctly" unreachable. The honest gate is `hasPattern`: with
    // no inferable rhythm `inferWeeklyRhythm` returns EVERY weekday with
    // `hasPattern: false` (a deliberate "no opinion", which is why `weekdays.length` is
    // not the question), and the message the tick would then build is
    // `buildWorkoutTargetReminder` over a profile with no training — which returns null.
    // A profile with a real pattern genuinely sends.
    workoutNudgeScheduled:
      sched.workoutEnabled && inferWorkoutSchedule(profileId).hasPattern,
    preventiveNudges,
  };
}

// ── Preventive: the planner's outstanding set ─────────────────────────────────

// The preventive rules that are OVERDUE (the window genuinely elapsed — never the
// `setup`/never-recorded state, which `actionable` already excludes, and never a merely
// upcoming `due`), are NOT covered by a future matching booking, and are NOT suppressed
// on the shared bus. That is exactly the set `runPreventive` would still be nudging
// about, composed from the same three reads it composes it from — a READ of the planner,
// not a second planner.
function gatherPreventiveUnactioned(
  profileId: number,
  today: string
): SetupPreventiveItem[] {
  const assessments = assessProfilePreventive(
    profileId,
    today
  ).actionable.filter((a) => a.status === "overdue");
  if (assessments.length === 0) return [];
  const scheduled = kindedScheduled(profileId);
  const suppressions = getFindingSuppressions(profileId);
  return assessments
    .filter((a) => scheduledMatchForRule(a.key, scheduled, today) == null)
    .filter((a) => {
      const rec = suppressions.get(preventiveSignalKey(a.kind, a.key));
      return !(rec != null && isSuppressed(rec, today));
    })
    .map((a) => ({ ruleKey: a.key, name: a.name }));
}

// ── The gather ────────────────────────────────────────────────────────────────

// REQUEST-MEMOIZED on (profileId, today). Two surfaces ask overlapping questions of the
// same snapshot — the household card wants the whole row, Settings → Notifications wants
// only the routing verdict — and the answer changes only at the profile-local date
// rollover, which `today` already names. Nothing in a request writes a dose, an
// onboarding row or a grant between the two reads.
export const gatherHouseholdSetupFacts = cache(
  gatherHouseholdSetupFactsUncached
);

function gatherHouseholdSetupFactsUncached(
  profileId: number,
  today: string
): HouseholdSetupFacts {
  const preventiveUnactioned = gatherPreventiveUnactioned(profileId, today);
  const items = getSupplements(profileId);
  const dosedItemIds = new Set(
    getSupplementDoses(profileId).map((d) => d.item_id)
  );
  const undosedItems: SetupIntakeItem[] = [];
  let active = 0;
  let inactive = 0;
  let inactiveObligated = 0;
  for (const item of items) {
    if (item.active) {
      active++;
      // Scheduled-SHAPED but undoseable: a `may` item has no dueness at all (#1505), so
      // its having no dose row is not a defect.
      if (isPushedIntake(item) && !dosedItemIds.has(item.id)) {
        undosedItems.push({ id: item.id, name: item.name, kind: item.kind });
      }
    } else {
      inactive++;
      if (isPushedIntake(item)) inactiveObligated++;
    }
  }
  const presence = getOnboardingDataPresence(profileId);
  return {
    sendSources: gatherSendSources(profileId, preventiveUnactioned.length),
    routing: profileRoutingFacts(profileId),
    onboardingStarted: getOnboardingState(profileId) !== null,
    hasStoredData: Object.values(presence).some(Boolean),
    undosedItems,
    preventiveUnactioned,
    roster: { active, inactive, inactiveObligated },
  };
}

// ── The readers ───────────────────────────────────────────────────────────────

// Whether THIS profile's messages would reach nobody, and why — the narrow question
// Settings → Notifications asks so the state is visible at the exact place someone would
// configure it. It is the SAME predicate over the SAME gathered snapshot the household
// row is built from, so the two surfaces can never disagree about one profile.
export function profileUnroutableReason(
  profileId: number,
  today: string
): UnroutableReason | null {
  return unroutable(gatherHouseholdSetupFacts(profileId, today));
}

// The member's setup row, suppression-filtered, or null when their setup is healthy (or
// the row's current EPISODE has been dismissed).
//
// The suppression consult is gated on `dismissible`, which is false whenever the
// unroutable check is in the failing set: constraint 3 forbids a standing "this profile
// is unroutable" dismissal, so no stored row of any shape can hide one. Every other
// combination honours the bus, keyed on the failing-check SET — so a dismissal survives
// until a NEW check type fails, and then the row is offered again under its new key.
export function householdSetupForProfile(
  profileId: number,
  today: string
): HouseholdSetupRow | null {
  const row = detectHouseholdSetup(gatherHouseholdSetupFacts(profileId, today));
  if (!row || !row.dismissible) return row;
  const rec = getFindingSuppressions(profileId).get(row.dedupeKey);
  return rec != null && isSuppressed(rec, today) ? null : row;
}
