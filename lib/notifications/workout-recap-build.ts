// WHAT THE FINISH MESSAGE SAYS ABOUT THE SESSION — the recap half of the post-workout
// nudge, gathered once and composed by two callers (issue #4996).
//
// ── Why this is its own module ───────────────────────────────────────────────
//
// The recap line, its physiology clause, its weekly status and the #2272 type ask used
// to be assembled inline inside `runPostWorkoutForActivity`, which is fine while the
// send is the only thing that composes them. #4996 gives the recap a PROSE RECONCILER,
// and the registry's rule for that class is NO SECOND RENDERER: the sweep re-runs the
// same builder the send ran. So the gather moved here, where both can reach it, and
// ./workout-presence keeps the dose section, the dispatch claim and the one-shot marker
// — the parts that are about SENDING rather than about what the message says.
//
// It deliberately does NOT import ./index (the dispatch fan-out), which is what lets
// ./reconcile call it without pulling the delivery stack into the sweep.
//
// ── The correction this exists for ───────────────────────────────────────────
//
// One ride, four uploaded rows, one message — and the message is the FIRST source's.
// Health Connect lands 30-45 min before Strava on every ride and declines to classify,
// so the rider gets "🏋️ Session complete" with the type ask; the auto-merge then folds
// all four, keeps the Strava row under a NEW id, and `carryPostWorkoutMarker` carries
// the announcement onto it so the good row is never announced. That is #2570 working:
// one ride, one message. What was missing is that the merge replaced the sentence's
// SUBJECT, and nothing went back and said so.

import { db } from "../db";
import {
  getLoginTelegramDisabledKinds,
  getProfileHomeAssistant,
} from "../settings";
import { isKindEnabled } from "./home-assistant-core";
import { resolveTelegramRecipients } from "./fan-out";
import { getSessionRecap } from "../queries/session-recap";
import { getFrequencyTargetProgress } from "../queries";
import { getEventPhysiology } from "../queries/event-physiology";
import { getSessionCadenceFacts } from "../queries/cadence-ledger";
import { getConnection, STRAVA_ID } from "../integrations/connections";
import { getArrivalLagMinutes } from "../queries/integrations";
import type { ActivityType } from "../types/training";
import type { NotificationMessage } from "./types";
import type { MessagePointer } from "./message-pointers";
import { keyboardTokens } from "./reconcile-core";
import { parseActivityTypeAskCallback } from "./callback-data";
import { recapRebuildTarget } from "./post-workout-marker";
import {
  ACTIVITY_TYPE_ASK_PROMPT,
  stravaDetailsFollowLine,
  activityTypeAskActions,
  composeFinishNudge,
  importedRecapLine,
  recapNudgeLine,
  sessionPhysiologyClause,
  weeklyRemainingLine,
  type FinishTypeAsk,
  type ImportedSessionFacts,
} from "./workout-recap-format";

// The imported row's own facts, for the #2272 recap line, plus the two fields the
// composition branches on: `source` (is this an import at all) and `type` (is it the
// stated absence the ask is for). One read; profile-scoped.
export interface FinishRow {
  date: string;
  start_time: string | null;
  end_time: string | null;
  duration_min: number | null;
  elapsed_min: number | null;
  distance_km: number | null;
  avg_hr: number | null;
  max_hr: number | null;
  relative_effort: number | null;
  title: string;
  // The column's CHECK enum, which is the declared tuple (#2272) — carried as the type
  // so the ask's `unclassified` test and the title map read the same vocabulary.
  type: ActivityType;
  source: string | null;
}

export function loadFinishRow(
  profileId: number,
  activityId: number
): FinishRow | null {
  const row = db
    .prepare(
      `SELECT date, start_time, end_time, duration_min, elapsed_min, distance_km,
              avg_hr, max_hr, relative_effort, title, type, source
         FROM activities WHERE id = ? AND profile_id = ?`
    )
    .get(activityId, profileId) as FinishRow | undefined;
  return row ?? null;
}

function importedFacts(row: FinishRow): ImportedSessionFacts {
  return {
    title: row.title,
    // Active minutes are the pace/volume source (#1202); an import that carried only a
    // wall-clock span still has something honest to say, so fall back to elapsed.
    durationMin: row.duration_min ?? row.elapsed_min,
    distanceKm: row.distance_km,
    avgHr: row.avg_hr,
    maxHr: row.max_hr,
    relativeEffort: row.relative_effort,
  };
}

// IS A RICHER SOURCE ACTUALLY COMING? (#4996) The provisional line is a promise, so it
// is read off `integration_connections` rather than assumed: a profile with no Strava
// connection is never told to wait for one, and a row that CAME from Strava is already
// as detailed as it will get. Strava is the app's only richer activity source today, so
// the copy names it; a second one would make this a lookup rather than a comparison.
function stravaDetailsFollow(profileId: number, row: FinishRow): boolean {
  if (row.source === STRAVA_ID) return false;
  return getConnection(profileId, STRAVA_ID)?.status === "connected";
}

// The recap half of the finish message, for one activity id.
export interface FinishRecapParts {
  // What finished, for the title. Null when the row could not be read.
  type: ActivityType | null;
  // The recap line plus its weekly status, or null when there is nothing to recap.
  leadLine: string | null;
  // The #2272 type ask, carrying #4996's provisional line when one is warranted.
  ask: FinishTypeAsk | null;
}

/**
 * Gather everything the finish message says about the SESSION — the same computation
 * for the send and for the reconcile rebuild, so the two can never drift about what the
 * message claims.
 */
export function finishRecapParts(
  profileId: number,
  activityId: number
): FinishRecapParts {
  const finishRow = loadFinishRow(profileId, activityId);
  const recap = getSessionRecap(profileId, activityId);
  // Recap-line inclusion (#924) is gated by the `workout-recap` row of the #928
  // kind×channel matrix — included unless it's turned OFF on EVERY delivery path.
  // Telegram is now LOGIN-scoped (#1072) and fans out to the managing logins, so the
  // line is enabled on Telegram if ANY managing login left it on; Home Assistant
  // stays per-profile. The push channel gates its own copy at dispatch; a recap-only
  // message additionally carries kind "workout-recap" so each channel's matrix gate
  // applies at send time.
  const recapEnabled =
    resolveTelegramRecipients(profileId).some((r) =>
      isKindEnabled("workout-recap", getLoginTelegramDisabledKinds(r.loginId))
    ) ||
    isKindEnabled(
      "workout-recap",
      getProfileHomeAssistant(profileId).disabledKinds
    );
  // WHAT THE MINUTE STREAM SAYS (#4775 §2). The same event-physiology result the
  // activity page renders, formatted as a clause on whatever recap line is already
  // going out. Read only when the recap line is enabled at all and the row can be
  // bounded, so a profile with the kind off pays nothing for it.
  const physiology =
    recapEnabled && finishRow ? getEventPhysiology(profileId, finishRow) : null;
  const hrClause = physiology ? sessionPhysiologyClause(physiology) : null;
  // #2272: an IMPORTED finish has no `exercise_sets`, so the strength recap declines
  // and the message had nothing to say. Its own facts stand in — EXCEPT its avg/max
  // HR when the stream has covered the window, because then the two would state the
  // same quantity twice from two sources and invite the reader to reconcile them. The
  // stream's split is the more specific claim, so it wins and the import's summary
  // steps aside; with no coverage the import's figure is all there is and is kept.
  const importedLine =
    recapEnabled && finishRow?.source
      ? importedRecapLine(
          hrClause
            ? { ...importedFacts(finishRow), avgHr: null, maxHr: null }
            : importedFacts(finishRow)
        )
      : null;
  const baseLine = recapNudgeLine(recap, recapEnabled) ?? importedLine;
  // The clause RIDES a line and never makes one: a manual row with nothing to recap
  // sends exactly what it sent before this issue.
  const recapLine =
    baseLine && hrClause ? `${baseLine} · ${hrClause}` : baseLine;
  // §3 (#981): the recap line gains a forward-looking weekly-remaining status, from the
  // SAME weekly rollup the reminder reads (#221). It rides WITH the recap line (the
  // congratulatory moment) — omitted when there's no recap line to lead it, no targets,
  // or the message is dose-only.
  //
  // The rollup is profile-wide, so the facts of THIS session go with it (#2503): without
  // them the line led with the closest-to-done target anywhere, and a walk's recap
  // reported a chest target a barbell session had advanced earlier in the week.
  const weeklyLine = recapLine
    ? weeklyRemainingLine(
        getFrequencyTargetProgress(profileId),
        getSessionCadenceFacts(profileId, activityId)
      )
    : null;
  // THE ASK (#2272). Offered only when the finishing row is the stated absence itself,
  // and only ON a message already going out — it adds no send of its own. One offer per
  // activity, carried by the same one-shot marker the nudge already burns: if it is
  // ignored the row stays `unclassified` and stays correctable in the app forever. A
  // queue that re-asks is how a signal gets trained into noise.
  const ask: FinishTypeAsk | null =
    finishRow?.type === "unclassified"
      ? {
          prompt: ACTIVITY_TYPE_ASK_PROMPT,
          actions: activityTypeAskActions(profileId, activityId),
          // The promise, and — when this profile's own Strava arrivals clear the
          // sample gate — how long it usually takes (#5001). Measured only where the
          // line is actually going out, so a profile with no Strava connection never
          // pays for the query.
          ...(stravaDetailsFollow(profileId, finishRow)
            ? {
                provisional: stravaDetailsFollowLine(
                  getArrivalLagMinutes(profileId, {
                    targetTable: "activities",
                    sourceId: STRAVA_ID,
                  })
                ),
              }
            : {}),
        }
      : null;
  return {
    type: finishRow?.type ?? null,
    leadLine:
      recapLine && weeklyLine ? `${recapLine}\n${weeklyLine}` : recapLine,
    ask,
  };
}

// The activity a delivered recap ANNOUNCED, read off its `actype:<profile>:<id>` token.
//
// The token is how the reconciler already addresses this message (the `actype` entry in
// ./reconcile-registry), and it is the only address a delivered recap carries — so a
// recap whose row was CLASSIFIED at send time has no token, no address, and is left
// exactly as delivered. That is the scope #4996 fixed: the arrival-order defect is the
// untyped first twin, and the untyped twin is precisely the one that carries the ask.
function announcedActivityId(
  profileId: number,
  pointer: MessagePointer
): number | null {
  for (const token of keyboardTokens(pointer.keyboard)) {
    const parsed = parseActivityTypeAskCallback(token);
    if (parsed && parsed.profileId === profileId) return parsed.activityId;
  }
  return null;
}

/**
 * The `workout-recap` prose reconciler (#4996): the finish message this recap WOULD be
 * if it were composed now, for the row the app now knows the session by.
 *
 * `recapRebuildTarget` is the identity half — the fold registered where the announced
 * row's subject went — and `finishRecapParts` is the same gather the send ran. Null when
 * the message carries no address, or when its row is gone with no registered keeper: a
 * reconciler that cannot name its subject leaves the message alone rather than editing
 * it on a guess.
 *
 * NO SECOND SEND, EVER. This composes the recap-only shape and hands it to the sweep,
 * which EDITS the message that already exists. `composeFinishNudge` is passed a null
 * dose message on purpose: a finish whose dose section was present was delivered under
 * kind "dose" and is reconciled by the `intake-dose` family, so it never reaches here.
 */
export function rebuildWorkoutRecap(
  profileId: number,
  pointer: MessagePointer
): NotificationMessage | null {
  const announced = announcedActivityId(profileId, pointer);
  if (announced == null) return null;
  const target = recapRebuildTarget(profileId, announced);
  if (!loadFinishRow(profileId, target)) return null;
  const parts = finishRecapParts(profileId, target);
  return composeFinishNudge(parts.leadLine, null, parts.ask, parts.type);
}
