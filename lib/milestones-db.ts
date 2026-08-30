// Milestone persistence + gather + run orchestration (issue #32). The pure
// threshold engine is lib/milestones.ts; this module reads the cumulative stats it
// needs from the profile-scoped query layer, records newly-crossed milestones in
// the `milestones` table (which doubles as the once-only fired marker AND the
// record source), and optionally sends a quiet notification. Called once per
// profile per hourly tick from scripts/notify.ts, next to the refill/digest runs.

import { db, writeTx } from "./db";
import { isDraftActivityRow, type DraftCandidateRow } from "./activity-draft";
import { getProfileAge, getPublicUrl } from "./settings";
import { getOutcomeGoals } from "./queries";
import {
  detectMilestones,
  type Milestone,
  type MilestoneInput,
} from "./milestones";
import { getProfileSetting } from "./settings";
import { dispatch } from "./notifications";
import type { NotificationMessage } from "./notifications/types";
import { createLogger } from "./log";
import { GLYPH } from "./notifications/glyphs";
import { isStrengthTrainingRelevant, isTrainingRelevant } from "./life-stage";

const log = createLogger("notify");

// The set of milestone keys already recorded for a profile (a present key means
// "already fired, never re-fire"). Profile-scoped read.
export function getFiredMilestoneKeys(profileId: number): Set<string> {
  const rows = db
    .prepare("SELECT key FROM milestones WHERE profile_id = ?")
    .all(profileId) as { key: string }[];
  return new Set(rows.map((r) => r.key));
}

// Count of every activity ever logged (the "Nth workout" basis). Profile-scoped.
//
// A DRAFT IS NOT A WORKOUT (#3190, owner-ruled). Create-at-start writes the row when
// the session opens, so a session someone opened and abandoned used to count toward
// the Nth-workout thresholds — measured, not hypothetical. This one cannot be put
// right later the way a wrong tile can: the notification is unrecallable once sent,
// and `recordMilestones` then writes the key as fired, so a husk does not merely
// produce a wrong recognition — it CONSUMES the moment, and the real Nth workout
// never gets one. Wrong once, permanently, per milestone. (Keys already stranded
// that way are released by migration 20260819-unstrand-husk-milestones.)
//
// The rule is not restated in SQL: the query gathers the draft-candidate columns
// `isDraftActivityRow` already reads off a row plus the "has any set" half as a
// correlated EXISTS on the same SELECT, and the fold applies THAT function. One
// prepared statement, as before — this runs once per profile per hourly tick, off
// every render path.
function totalWorkouts(profileId: number, includeStrength: boolean): number {
  const rows = db
    .prepare(
      `SELECT a.start_time, a.end_time, a.duration_min, a.components, a.notes,
              a.distance_km, a.source,
              EXISTS (
                SELECT 1 FROM exercise_sets s WHERE s.activity_id = a.id
              ) AS has_sets
         FROM activities a
        WHERE a.profile_id = ? AND (? = 1 OR a.type != 'strength')`
    )
    .all(profileId, includeStrength ? 1 : 0) as (DraftCandidateRow & {
    /** 0 or 1 — the draft rule only asks whether ANY set exists (`setCount > 0`). */
    has_sets: number;
  })[];
  let n = 0;
  for (const row of rows) if (!isDraftActivityRow(row, row.has_sets)) n++;
  return n;
}

// Gather the cumulative stats the pure engine needs for one profile.
export function gatherMilestoneInput(profileId: number): MilestoneInput {
  const age = getProfileAge(profileId);
  const trainingRelevant = isTrainingRelevant(age);
  const strengthTrainingRelevant = isStrengthTrainingRelevant(age);
  return {
    totalWorkouts: trainingRelevant
      ? totalWorkouts(profileId, strengthTrainingRelevant)
      : 0,
    completedGoals: trainingRelevant
      ? getOutcomeGoals(profileId)
          .filter(
            (g) =>
              g.status === "achieved" &&
              !g.archived &&
              (strengthTrainingRelevant || g.kind !== "exercise")
          )
          .map((g) => ({ id: g.id, title: g.title }))
      : [],
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
  writeTx(() => {
    for (const m of milestones)
      stmt.run(profileId, m.key, m.kind, m.threshold, m.title, m.detail, date);
  });
}

// A quiet notification listing the milestones just reached. Factual, no reward
// framing. Returns null when there's nothing to announce.
export function renderMilestoneMessage(
  profileName: string,
  milestones: Milestone[],
  deepLinkBase = ""
): NotificationMessage | null {
  if (milestones.length === 0) return null;
  const who = profileName ? ` — ${profileName}` : "";
  const head =
    milestones.length === 1
      ? milestones[0].title
      : `${milestones.length} milestones reached`;
  // RENDER THE DETAIL (#1722 item 1). The body restated the title verbatim while
  // `Milestone.detail` — the warm, contextual line computed in lib/milestones.ts and
  // PERSISTED to the milestones table ("You've logged 100 workouts. Consistency is the
  // point — nice going.") — was never shown. A single milestone leads with its detail;
  // several keep the title as the label and hang the detail off it.
  const body = milestones
    .map((m) => {
      const detail = m.detail?.trim();
      if (milestones.length === 1) return detail || m.title;
      return detail
        ? `${GLYPH.bullet} ${m.title} — ${detail}`
        : `${GLYPH.bullet} ${m.title}`;
    })
    .join("\n");
  const base = deepLinkBase.replace(/\/$/, "");
  return {
    title: `${GLYPH.finish} Milestone${who}: ${head}`,
    body,
    kind: "milestone",
    // Milestones always land on the Timeline, so that is where "see it" goes.
    ...(base
      ? { actions: [{ label: "Open History →", url: `${base}/history` }] }
      : {}),
  };
}

// Detect + record + (optionally) announce this profile's milestones. Recording
// always happens (so the record shows them); the notification is gated on a
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

  // Record first so a milestone is on the record even if notification fails.
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

  const msg = renderMilestoneMessage(profileName, detected, getPublicUrl());
  if (!msg) return { failed: false, fired: detected.length };
  const results = await dispatch(profileId, msg);
  const failed = results.some((r) => !r.ok);
  return { failed, fired: detected.length };
}
