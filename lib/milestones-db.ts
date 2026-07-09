// Milestone persistence + gather + run orchestration (issue #32). The pure
// threshold engine is lib/milestones.ts; this module reads the cumulative stats it
// needs from the profile-scoped query layer, records newly-crossed milestones in
// the `milestones` table (which doubles as the once-only fired marker AND the
// timeline source), and optionally sends a quiet notification. Called once per
// profile per hourly tick from scripts/notify.ts, next to the refill/digest runs.

import { db, today } from "./db";
import { shiftDateStr } from "./date";
import {
  getActivityDates,
  getGoals,
  getSupplements,
  getSupplementDoses,
  getTakenDoseIds,
  getActivitiesByDate,
} from "./queries";
import { isDueOn } from "./supplement-schedule";
import { flexibleStreak } from "./streak";
import {
  detectMilestones,
  adherenceRunLength,
  type Milestone,
  type MilestoneInput,
  type AdherenceDay,
} from "./milestones";
import { getActiveSituations, getProfileSetting } from "./settings";
import { dispatch } from "./notifications";
import type { NotificationMessage } from "./notifications/types";
import { createLogger } from "./log";

const log = createLogger("notify");

// How far back to look for the perfect-adherence run. Comfortably past the largest
// adherence threshold (30) so a full month's run is measurable.
const ADHERENCE_LOOKBACK_DAYS = 40;

// The set of milestone keys already recorded for a profile (a present key means
// "already fired, never re-fire"). Profile-scoped read.
export function getFiredMilestoneKeys(profileId: number): Set<string> {
  const rows = db
    .prepare("SELECT key FROM milestones WHERE profile_id = ?")
    .all(profileId) as { key: string }[];
  return new Set(rows.map((r) => r.key));
}

// Count of every activity ever logged (the "Nth workout" basis). Profile-scoped.
function totalWorkouts(profileId: number): number {
  const row = db
    .prepare("SELECT COUNT(*) AS n FROM activities WHERE profile_id = ?")
    .get(profileId) as { n: number };
  return row.n;
}

// Per-day supplement due/taken over the trailing ADHERENCE_LOOKBACK_DAYS, oldest
// first — the input to the pure adherenceRunLength. Mirrors the digest gather's
// due-dose derivation (isDueOn honoring workout-day + active situations). Today is
// excluded so a day still in progress can't read as a miss.
function adherenceDays(profileId: number, td: string): AdherenceDay[] {
  const active = getSupplements(profileId).filter((s) => s.active);
  if (active.length === 0) return [];
  const suppById = new Map(active.map((s) => [s.id, s]));
  const doses = getSupplementDoses(profileId).filter((d) =>
    suppById.has(d.supplement_id)
  );
  if (doses.length === 0) return [];
  const situations = new Set(getActiveSituations(profileId));

  const days: AdherenceDay[] = [];
  // Oldest → yesterday (exclude today, which is still settling).
  for (let back = ADHERENCE_LOOKBACK_DAYS; back >= 1; back--) {
    const date = shiftDateStr(td, -back);
    const isWorkoutDay = getActivitiesByDate(profileId, date).length > 0;
    const dueIds = doses
      .filter((d) =>
        isDueOn(suppById.get(d.supplement_id)!, {
          isWorkoutDay,
          activeSituations: situations,
        })
      )
      .map((d) => d.id);
    if (dueIds.length === 0) {
      days.push({ due: 0, taken: 0 });
      continue;
    }
    const taken = getTakenDoseIds(profileId, date);
    days.push({
      due: dueIds.length,
      taken: dueIds.filter((id) => taken.has(id)).length,
    });
  }
  return days;
}

// Gather the cumulative stats the pure engine needs for one profile.
export function gatherMilestoneInput(profileId: number): MilestoneInput {
  const td = today(profileId);
  return {
    totalWorkouts: totalWorkouts(profileId),
    streak: flexibleStreak(td, getActivityDates(profileId)),
    adherenceRun: adherenceRunLength(adherenceDays(profileId, td)),
    completedGoals: getGoals(profileId)
      .filter((g) => g.status === "achieved" && !g.archived)
      .map((g) => ({ id: g.id, title: g.title })),
    fired: getFiredMilestoneKeys(profileId),
  };
}

// Persist newly-detected milestones. INSERT OR IGNORE against the unique
// (profile_id, key) index makes it safe if two ticks race. achieved_on is the
// detection date (the honest "recognized on" date; there's no reliable historical
// crossing date for cumulative counts).
export function recordMilestones(
  profileId: number,
  milestones: Milestone[],
  date: string
): void {
  if (milestones.length === 0) return;
  const stmt = db.prepare(
    `INSERT OR IGNORE INTO milestones
       (profile_id, key, kind, threshold, title, detail, achieved_on)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const tx = db.transaction((rows: Milestone[]) => {
    for (const m of rows)
      stmt.run(profileId, m.key, m.kind, m.threshold, m.title, m.detail, date);
  });
  tx(milestones);
}

// A quiet notification listing the milestones just reached. Factual, no reward
// framing. Returns null when there's nothing to announce.
export function renderMilestoneMessage(
  profileName: string,
  milestones: Milestone[]
): NotificationMessage | null {
  if (milestones.length === 0) return null;
  const who = profileName ? ` — ${profileName}` : "";
  const head =
    milestones.length === 1
      ? milestones[0].title
      : `${milestones.length} milestones reached`;
  const body = milestones.map((m) => `• ${m.title}`).join("\n");
  return { title: `🏁 Milestone${who}: ${head}`, body };
}

// Detect + record + (optionally) announce this profile's milestones. Recording
// always happens (so the timeline shows them); the notification is gated on a
// per-profile opt-out (notify_milestones, default on) and on a channel being
// configured. Returns whether a configured channel failed (folded into the tick
// exit code). Never throws for an ordinary send failure.
export async function runMilestones(
  profileId: number,
  profileName: string,
  date: string
): Promise<{ failed: boolean; fired: number }> {
  const detected = detectMilestones(gatherMilestoneInput(profileId));
  if (detected.length === 0) return { failed: false, fired: 0 };

  // Record first so a milestone is on the timeline even if notification fails.
  recordMilestones(profileId, detected, date);
  log.info("milestones recorded", {
    profile: profileId,
    keys: detected.map((m) => m.key),
  });

  // Opt-out: milestone alerts on unless explicitly disabled. Keeps celebration
  // minimal per the issue's tone note.
  if (getProfileSetting(profileId, "notify_milestones") === "0") {
    return { failed: false, fired: detected.length };
  }

  const msg = renderMilestoneMessage(profileName, detected);
  if (!msg) return { failed: false, fired: detected.length };
  const results = await dispatch(profileId, msg);
  const failed = results.some((r) => !r.ok);
  return { failed, fired: detected.length };
}
