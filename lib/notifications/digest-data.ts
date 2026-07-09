// Morning-digest DB gather + send orchestration (issue #135). Pulls the per-profile
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
  getActivitiesByDate,
  getFrequencyTargetProgress,
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
    suppById.has(d.supplement_id)
  );
  const situations = new Set(getActiveSituations(profileId));

  const dueDoseIds = (date: string): number[] => {
    const isWorkoutDay = getActivitiesByDate(profileId, date).length > 0;
    return doses
      .filter((d) => {
        const supp = suppById.get(d.supplement_id)!;
        return isDueOn(supp, { isWorkoutDay, activeSituations: situations });
      })
      .map((d) => d.id);
  };

  // Today: doses on deck + frequency targets not yet met this week.
  const doseCount = dueDoseIds(td).length;
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
  let adherence: { taken: number; due: number } | null = null;
  if (yDue.length > 0) {
    const taken = getTakenDoseIds(profileId, yd);
    adherence = {
      taken: yDue.filter((id) => taken.has(id)).length,
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
  // extracted documents. created_at/uploaded_at are datetime('now') UTC strings,
  // so `since` is computed in the same format for a correct string comparison.
  const { since } = db
    .prepare("SELECT COALESCE(?, datetime('now','-1 day')) AS since")
    .get(getProfileSetting(profileId, "notify_digest_last_at") ?? null) as {
    since: string;
  };

  const newFlaggedBiomarkers = (
    db
      .prepare(
        `SELECT name, value, flag FROM medical_records
          WHERE profile_id = ? AND created_at > ?
            AND flag IS NOT NULL AND flag != 'normal'
          ORDER BY created_at DESC LIMIT ?`
      )
      .all(profileId, since, MAX_FLAGGED) as {
      name: string;
      value: string | null;
      flag: string;
    }[]
  ).map((r): DigestFlaggedBiomarker => ({
    name: r.name,
    value: r.value,
    flag: r.flag,
  }));

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
