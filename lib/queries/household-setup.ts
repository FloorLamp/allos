// Whether a profile's reminders reach anyone — the DB gather behind the pure predicate
// in lib/household-setup.ts (issue #2173). DERIVED AT READ TIME: there is no stored
// state, no new engine and no new table. Granting a login access or configuring a
// channel clears it BY CONSTRUCTION.
//
// NO NEW SQL LIVES HERE ON PURPOSE. Each fact is asked through the reader its own domain
// already owns — `getIntakeItems` / `getIntakeDoses` for the roster,
// `assessProfilePreventive` + `kindedScheduled` + `getFindingSuppressions` for the
// preventive planner's own outstanding set, `getNotifySchedule` + `inferWorkoutSchedule`
// for the send sources, `profileRoutingFacts` for the edge set. Auth-blind, `profileId`
// first, like every other reader in this layer.

import {
  unroutable,
  type SendSourceFacts,
  type UnroutableReason,
} from "../household-setup";
import { isPushedIntake } from "../intake-schedule";
import { getNotifySchedule } from "../settings";
import { profileRoutingFacts } from "../notifications/routing";
import { getIntakeItems, getIntakeDoses } from "./intake/schedule";
import { inferWorkoutSchedule } from "./training/activities";
import { kindedScheduled } from "./appointments";
import { scheduledMatchForRule } from "../preventive-appointment";
import { preventiveSignalKey } from "../preventive-upcoming";
import { isSuppressed } from "../upcoming-suppress";
import { assessProfilePreventive, getFindingSuppressions } from "./upcoming";

// ── Send sources ──────────────────────────────────────────────────────────────

// The tick's own gates, asked as a question about the PROFILE rather than about this
// minute. The condition is structural: the only date read is the caller's `today`,
// which the preventive planner needs.
function gatherSendSources(profileId: number, today: string): SendSourceFacts {
  const sched = getNotifySchedule(profileId);
  const anyIntakeWindow = Object.values(sched.supplementMinutes).some(
    (m) => m != null
  );
  let scheduledIntake = 0;
  if (anyIntakeWindow) {
    const dosedItemIds = new Set(
      getIntakeDoses(profileId).map((d) => d.item_id)
    );
    scheduledIntake = getIntakeItems(profileId).filter(
      (item) => item.active && isPushedIntake(item) && dosedItemIds.has(item.id)
    ).length;
  }
  return {
    scheduledIntake,
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
    preventiveNudges: countPreventiveUnactioned(profileId, today),
  };
}

// ── Preventive: the planner's outstanding set ─────────────────────────────────

// How many preventive rules are OVERDUE (the window genuinely elapsed — never the
// `setup`/never-recorded state, which `actionable` already excludes, and never a merely
// upcoming `due`), are NOT covered by a future matching booking, and are NOT suppressed
// on the shared bus. That is exactly the set `runPreventive` would still be nudging
// about, composed from the same three reads it composes it from — a READ of the planner,
// not a second planner.
function countPreventiveUnactioned(profileId: number, today: string): number {
  const assessments = assessProfilePreventive(
    profileId,
    today
  ).actionable.filter((a) => a.status === "overdue");
  if (assessments.length === 0) return 0;
  const scheduled = kindedScheduled(profileId);
  const suppressions = getFindingSuppressions(profileId);
  return assessments
    .filter((a) => scheduledMatchForRule(a.key, scheduled, today) == null)
    .filter((a) => {
      const rec = suppressions.get(preventiveSignalKey(a.kind, a.key));
      return !(rec != null && isSuppressed(rec, today));
    }).length;
}

// Whether THIS profile's messages would reach nobody, and why — the question
// Settings → Notifications asks so the state is visible at the exact place someone
// would configure it.
export function profileUnroutableReason(
  profileId: number,
  today: string
): UnroutableReason | null {
  return unroutable({
    sendSources: gatherSendSources(profileId, today),
    routing: profileRoutingFacts(profileId),
  });
}
