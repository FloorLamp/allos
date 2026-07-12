// Morning-digest DB gather + send orchestration. Pulls the per-profile
// facts the digest summarizes from the already-scoped query layer (plus two small
// profile-scoped reads for "new since last digest"), hands them to the pure
// buildDigest, and dispatches the rendered message. Called once per hour per
// profile from the notify tick; hard-deduped to one send per profile per day.

import { db, today } from "../db";
import { shiftDateStr } from "../date";
import {
  getSupplements,
  getSupplementDoses,
  getTakenDoseIds,
  getSkippedDoseIds,
  getActivitiesByDate,
  isPredictedWorkoutDay,
  getFrequencyTargetProgress,
  getCurrentFlaggedBiomarkers,
} from "../queries";
import { isDueOn } from "../supplement-schedule";
import {
  getActiveSituations,
  getProfileSetting,
  setProfileSetting,
} from "../settings";
import { dispatch } from "./index";
import {
  buildDigest,
  dedupeFlaggedByAnalyte,
  renderDigestMessage,
  type DigestActivity,
  type DigestFlaggedBiomarker,
  type DigestGoalDue,
  type DigestInput,
} from "./digest";
import { createLogger } from "../log";

const log = createLogger("notify");

// A few labels are enough for a glanceable line; the section says the count.
const MAX_NEW_DOCS = 5;
const MAX_FLAGGED = 8;

// The "since" cursor for the "new since last digest" reads: the stored last-digest
// timestamp, or 24h ago on the first run so the first digest doesn't dump the
// entire history of flagged results. created_at/uploaded_at are datetime('now')
// UTC strings, so this is computed in the same format for a correct string
// comparison. This cursor is the DIGEST's window only (it advances on every send)
// — the dashboard hero passes its own stable window into
// getNewlyFlaggedBiomarkers (lib/queries/attention.ts), so sending a digest never
// changes what the hero shows (issue #283).
export function digestSince(profileId: number): string {
  return (
    db
      .prepare("SELECT COALESCE(?, datetime('now','-1 day')) AS since")
      .get(getProfileSetting(profileId, "notify_digest_last_at") ?? null) as {
      since: string;
    }
  ).since;
}

// Out-of-range biomarkers newly flagged since `since` (profile-scoped). This is the
// single read behind BOTH the digest's "New" section and the dashboard hero's
// flagged-biomarker attention items, so the two can never disagree on which results
// are "newly flagged" — each surface passes its OWN window (`since`): the digest
// its send cursor, the hero a stable trailing window (issue #283).
//
// The heavy lifting is getCurrentFlaggedBiomarkers (lib/queries/medical.ts): it
// restricts to each analyte family's CURRENT (latest-per-family) reading via the
// SAME LATEST_IDS_CTE machinery the household/passport surfaces use, so a
// SUPERSEDED historical out-of-range reading (a 5-year-old low that a later normal
// reading replaced) never surfaces here — the #557 fix, a "one question, one
// computation" consolidation with the two sibling surfaces. It also windows on the
// COLLECTION date as well as the import cursor, so a history backfill (created_at
// today, collected years ago) can't light the window. "immune" is a good
// durable-immunity status (#544/#549), excluded there too. Names are
// canonical-preferred so links/dedupe key on the same identity the biomarker view
// resolves; repeat flags of one analyte already collapse to the current reading in
// the CTE, and dedupeFlaggedByAnalyte stays as a defensive collapse-by-name before
// the MAX_FLAGGED slice.
export function getNewlyFlaggedBiomarkers(
  profileId: number,
  since: string,
  limit = MAX_FLAGGED
): DigestFlaggedBiomarker[] {
  return dedupeFlaggedByAnalyte(
    getCurrentFlaggedBiomarkers(profileId, since).map(
      (r): DigestFlaggedBiomarker => ({
        name: r.name,
        canonicalName: r.canonicalName,
        value: r.value,
        flag: r.flag,
      })
    )
  ).slice(0, limit);
}

// Gather the digest facts for one profile. `since` bounds the "new since last
// digest" queries: the stored last-digest timestamp, or 24h ago on the first run
// so the first digest doesn't dump the entire history of flagged results.
export function gatherDigestInput(
  profileId: number,
  profileName: string
): DigestInput {
  const td = today(profileId);
  const yd = shiftDateStr(td, -1);

  const active = getSupplements(profileId).filter((s) => s.active);
  const suppById = new Map(active.map((s) => [s.id, s]));
  const doses = getSupplementDoses(profileId).filter((d) =>
    suppById.has(d.item_id)
  );
  const situations = new Set(getActiveSituations(profileId));

  // For TODAY, a pre_workout/rest_day item keys on the PREDICTED training day
  // (issue #558) so the morning digest lists it before the session, not only after
  // one is logged. Past days (yesterday's adherence) use the logged reality.
  const dueDoseIds = (date: string, forToday = false): number[] => {
    const isWorkoutDay = getActivitiesByDate(profileId, date).length > 0;
    const predictedWorkoutDay = forToday
      ? isPredictedWorkoutDay(profileId, date)
      : null;
    return doses
      .filter((d) => {
        const supp = suppById.get(d.item_id)!;
        return isDueOn(supp, {
          isWorkoutDay,
          activeSituations: situations,
          predictedWorkoutDay,
        });
      })
      .map((d) => d.id);
  };

  // Today: doses on deck + frequency targets not yet met this week.
  const todayDueIds = dueDoseIds(td, true);
  const doseCount = todayDueIds.length;
  const goalsDue: DigestGoalDue[] = getFrequencyTargetProgress(profileId)
    .filter((p) => !p.met)
    .map((p) => ({
      label: p.target.scope_value,
      count: p.count,
      perWeek: p.per_week,
    }));

  // Yesterday: activities, supplement adherence x/y, weight if logged.
  const activities: DigestActivity[] = getActivitiesByDate(profileId, yd).map(
    (a) => ({
      title: a.title,
      type: a.type,
      durationMin: a.duration_min,
      distanceKm: a.distance_km,
    })
  );
  const yDue = dueDoseIds(yd);

  // Distinct kinds among the doses the digest actually mentions (today's "on deck"
  // + yesterday's adherence), so the reminder noun reflects a medications-only or
  // mixed profile rather than always saying "supplements" (#380).
  const doseById = new Map(doses.map((d) => [d.id, d]));
  const intakeKinds = [
    ...new Set(
      [...todayDueIds, ...yDue]
        .map((id) => doseById.get(id))
        .filter((d): d is (typeof doses)[number] => d != null)
        .map((d) => suppById.get(d.item_id)!.kind)
    ),
  ];

  let adherence: { taken: number; skipped: number; due: number } | null = null;
  if (yDue.length > 0) {
    const taken = getTakenDoseIds(profileId, yd);
    const skipped = getSkippedDoseIds(profileId, yd);
    adherence = {
      taken: yDue.filter((id) => taken.has(id)).length,
      // Deliberate skips (#232) are shown alongside taken and excluded from the
      // percentage denominator (see buildDigest).
      skipped: yDue.filter((id) => skipped.has(id)).length,
      due: yDue.length,
    };
  }
  const weightRow = db
    .prepare(
      `SELECT weight_kg FROM body_metrics
        WHERE profile_id = ? AND date = ? AND weight_kg IS NOT NULL
        ORDER BY id DESC LIMIT 1`
    )
    .get(profileId, yd) as { weight_kg: number } | undefined;

  // New since the last digest: newly flagged out-of-range biomarkers + new
  // extracted documents. Both bounded by the shared `since` cursor.
  const since = digestSince(profileId);
  const newFlaggedBiomarkers = getNewlyFlaggedBiomarkers(
    profileId,
    since,
    MAX_FLAGGED
  );

  const newDocumentLabels = (
    db
      .prepare(
        `SELECT filename, doc_type, source FROM medical_documents
          WHERE profile_id = ? AND uploaded_at > ? AND extraction_status = 'done'
          ORDER BY uploaded_at DESC LIMIT ?`
      )
      .all(profileId, since, MAX_NEW_DOCS) as {
      filename: string;
      doc_type: string | null;
      source: string | null;
    }[]
  ).map((d) => d.source || d.doc_type || d.filename);

  return {
    profileName,
    doseCount,
    intakeKinds,
    goalsDue,
    activities,
    adherence,
    weightKg: weightRow?.weight_kg ?? null,
    newFlaggedBiomarkers,
    newDocumentLabels,
  };
}

// Build + send this profile's morning digest for `date`. Returns whether a send
// failed. Marks the day done (per-profile/day dedup) whether it sent or found
// nothing to say, but only advances the "since" timestamp on a real send so
// unsent new items still surface tomorrow.
export async function runDigest(
  profileId: number,
  profileName: string,
  date: string
): Promise<{ failed: boolean }> {
  const dedupKey = "notify_last_digest";
  const model = buildDigest(gatherDigestInput(profileId, profileName));
  if (!model) {
    // Nothing to report — mark the day done so we don't recompute every hour.
    setProfileSetting(profileId, dedupKey, date);
    log.info("digest: nothing to send", { profile: profileId });
    return { failed: false };
  }

  const results = await dispatch(profileId, renderDigestMessage(model));
  if (results.length === 0) {
    // No channel configured (Telegram off / no chat id): leave unmarked so it can
    // send once configured.
    return { failed: false };
  }
  const delivered = results.some((r) => r.ok);
  const failed = results.some((r) => !r.ok);
  if (delivered) {
    setProfileSetting(profileId, dedupKey, date);
    const now = db.prepare("SELECT datetime('now') AS n").get() as {
      n: string;
    };
    setProfileSetting(profileId, "notify_digest_last_at", now.n);
  }
  return { failed };
}
