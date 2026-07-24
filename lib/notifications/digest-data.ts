// Morning-digest DB gather + send orchestration. Pulls the per-profile
// facts the digest summarizes from the already-scoped query layer (plus two small
// profile-scoped reads for "new since last digest"), hands them to the pure
// buildDigest, and dispatches the rendered message. Called once per hour per
// profile from the notify tick; hard-deduped to one send per profile per day.

import { db, today } from "../db";
import { shiftDateStr, zonedDateParts } from "../date";
import {
  getSupplements,
  getSupplementDoses,
  getTakenDoseIds,
  getSkippedDoseIds,
  getActivitiesByDate,
  collectUpcoming,
  getCurrentFlaggedBiomarkers,
  getSleepSignal,
  getSleepRegularity,
  getSleepSessions,
  getMetricDailyTotals,
  getEffectiveActiveSituations,
  getDerivedSituationLines,
} from "../queries";
import { groupUpcoming } from "../upcoming";
import {
  mainSleepNights,
  sleepSessionDurationMinutes,
} from "../sleep-regularity";
import {
  countSituationalDue,
  heldItemsBy,
  doseReminderNotifies,
  isDueOn,
} from "../supplement-schedule";
import {
  getActiveSituations,
  getSituationEvents,
  getNotifySchedule,
  getProfileSetting,
  setProfileSetting,
  getProfileSleepDigest,
  getTimezone,
} from "../settings";
import { situationHistoryResolver } from "../trend-annotations";
import { currentEpisodeForProfile } from "../illness-episode";
import { episodeHeadline } from "../illness-episode-format";
import { dispatch } from "./index";
import {
  buildDigest,
  dedupeFlaggedByAnalyte,
  renderDigestMessage,
  type DigestActivity,
  type DigestFlaggedBiomarker,
  type DigestInput,
  type DigestSleep,
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

// Last night's sleep for the morning digest's Sleep section (issue #1117), or null
// when the summary is off (opt-in) or there's no FRESH sleep data. It composes the
// SAME computations other surfaces use — getSleepSignal (the rest trigger's main-
// overnight last-night + baseline, #1118/#221) and getSleepRegularity (the #160 SRI
// Trends renders) — so the digest can't disagree with them. Freshness gate: the
// most recent main-sleep night must be today or yesterday (you actually woke
// recently); a stale night isn't "how'd I sleep". The nap total is the wake-day's
// non-main sleep, kept apart from the overnight figure.
export function gatherDigestSleep(profileId: number): DigestSleep | null {
  if (!getProfileSleepDigest(profileId)) return null;
  const signal = getSleepSignal(profileId);
  if (!signal) return null;

  const tz = getTimezone(profileId);
  const sessions = getSleepSessions(profileId);
  const nights = mainSleepNights(sessions, tz);
  if (nights.length === 0) return null;
  const last = nights[nights.length - 1];

  const td = today(profileId);
  const yd = shiftDateStr(td, -1);
  if (last.wakeDay !== td && last.wakeDay !== yd) return null; // stale — skip

  // Nap = all sleep on the wake-day minus the main overnight session (never folded
  // into the overnight figure). Uses the same session windows as mainSleepNights.
  let dayTotalMin = 0;
  for (const s of sessions) {
    if (zonedDateParts(tz, new Date(s.end)).date !== last.wakeDay) continue;
    dayTotalMin += sleepSessionDurationMinutes(s);
  }
  const napMin = Math.max(0, Math.round(dayTotalMin) - last.durationMin);

  // Stage breakdown for the wake-day when the source reports it (HC/Oura/Withings).
  const stageFor = (metric: string): number | null => {
    const row = getMetricDailyTotals(profileId, metric, 14).find(
      (r) => r.date === last.wakeDay
    );
    return row ? Math.round(row.value) : null;
  };

  const reg = getSleepRegularity(profileId);
  return {
    lastNightMin: signal.lastNightMin,
    baselineMin: Math.round(signal.baselineMin),
    deepMin: stageFor("sleep_deep_min"),
    remMin: stageFor("sleep_rem_min"),
    napMin,
    sri: reg ? reg.sri : null,
  };
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
  // Per-day situation resolver (#654): "today" sees the current set (no events after
  // today), while yesterday's adherence is scored against the situations active THAT
  // day, not today's toggle applied retroactively.
  const situationsOn = situationHistoryResolver(
    getActiveSituations(profileId),
    getSituationEvents(profileId)
  );

  // Yesterday's adherence still scores against the LOGGED reality of that day, so
  // it keeps its own dueness helper (no predicted-training-day guess for the past).
  const dueDoseIdsOn = (date: string): number[] => {
    const isWorkoutDay = getActivitiesByDate(profileId, date).length > 0;
    return doses
      .filter((d) =>
        isDueOn(suppById.get(d.item_id)!, {
          isWorkoutDay,
          activeSituations: situationsOn(date),
          predictedWorkoutDay: null,
        })
      )
      .map((d) => d.id);
  };

  // Today: the MERGED "what's due" list (issue #1108). ONE engine (#221) — the
  // banded collectUpcoming, which already drops snoozed/dismissed items and
  // training items for an age-restricted profile, and whose dose items carry the
  // #558 predicted-training-day dueness. This REPLACES the digest's own dueDoseIds /
  // frequency-target computation, so the morning message and the Upcoming page/hero
  // can't disagree, and a page dismissal finally silences the digest too.
  let upcoming = collectUpcoming(profileId, td);
  // Preventive-care domain toggle (#87): off ⇒ no preventive visit/screening lines
  // in the digest (they still appear on the Upcoming page — that's pull, not push),
  // mirroring the proactive nudge suppression in ./preventive.
  if (!getNotifySchedule(profileId).preventiveEnabled) {
    upcoming = upcoming.filter(
      (i) => i.domain !== "visit" && i.domain !== "screening"
    );
  }
  const todayGroups = groupUpcoming(upcoming, td);
  // The dose glance headline counts the DUE dose items collectUpcoming surfaced
  // (bus-honored + #558) — the same items the Today section bands over. The
  // #1156 priority floor applies to this PUSH surface: a low-priority SUPPLEMENT
  // dose stays on the in-app surfaces (Upcoming, Supplements page) but is
  // excluded from the digest's actionable dose count — tracked, not nagged.
  const doseByIdForFloor = new Map(doses.map((d) => [d.id, d]));
  const todayDoseIds = upcoming
    .filter((i) => i.domain === "dose" && i.doseId != null)
    .map((i) => i.doseId as number)
    .filter((id) => {
      const d = doseByIdForFloor.get(id);
      const supp = d ? suppById.get(d.item_id) : undefined;
      return supp ? doseReminderNotifies(supp) : true;
    });
  const doseCount = todayDoseIds.length;

  // Yesterday: activities, supplement adherence x/y, weight if logged.
  const activities: DigestActivity[] = getActivitiesByDate(profileId, yd).map(
    (a) => ({
      title: a.title,
      type: a.type,
      durationMin: a.duration_min,
      distanceKm: a.distance_km,
    })
  );
  const yDue = dueDoseIdsOn(yd);

  // Distinct kinds among the doses the digest actually mentions (today's due list
  // from collectUpcoming + yesterday's adherence), so the reminder noun reflects a
  // medications-only or mixed profile rather than always saying "supplements" (#380).
  const doseById = new Map(doses.map((d) => [d.id, d]));
  const intakeKinds = [
    ...new Set(
      [...todayDoseIds, ...yDue]
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

  // "New" means the extraction COMPLETED since the cursor (issue #1022) — not
  // uploaded since. `extraction_completed_at` is stamped by the one 'done'
  // transition (lib/import-persist.ts), so a document that finished extracting
  // after a digest already passed its upload time (the upload/digest race) or
  // that failed and was reprocessed days later still announces exactly once, the
  // morning after it actually became readable. Backfilled rows (migration 075)
  // carry their uploaded_at, keeping pre-existing history out of the window.
  const newDocumentLabels = (
    db
      .prepare(
        `SELECT filename, doc_type, source FROM medical_documents
          WHERE profile_id = ? AND extraction_completed_at > ?
            AND extraction_status = 'done'
          ORDER BY extraction_completed_at DESC LIMIT ?`
      )
      .all(profileId, since, MAX_NEW_DOCS) as {
      filename: string;
      doc_type: string | null;
      source: string | null;
    }[]
  ).map((d) => d.source || d.doc_type || d.filename);

  // An open illness episode leads the digest (#859 item 5) — the SAME assembly the
  // hero/household line format over (currentEpisodeForProfile → episodeHeadline).
  const openEp = currentEpisodeForProfile(profileId);
  const openEpisodeLine = openEp ? episodeHeadline(openEp) : null;

  // Situation-activation mention (#662 item 1): count situational items due today
  // because their situation is active, via the SAME dueness computation the dose
  // list uses (countSituationalDue → isDueOn). The situational branch ignores the
  // workout fields, so a minimal ctx (today's active set) is sufficient.
  // Derived context (#1292/#1298) widens the active set for today, so a Poor sleep /
  // Period item is counted due here exactly as it is on the bar. The derived state
  // lines below carry the same basis-aware acknowledgment (#662) so a Telegram-first
  // user isn't surprised by the extra due items.
  const effectiveSituations = getEffectiveActiveSituations(profileId, td);
  const situationalActiveCount = countSituationalDue(active, {
    isWorkoutDay: false,
    activeSituations: effectiveSituations,
  });
  const derivedLines = getDerivedSituationLines(profileId, td);
  const derivedSituationLines = [
    derivedLines.poorSleep,
    derivedLines.period,
  ].filter((l): l is string => l != null);

  // Held items (#1296): active intake items currently suppressed by a pause situation,
  // via the SAME heldItemsBy computation the Supplements/Medications rows and the badge
  // use (#221). It reads the SAME effectiveSituations (declared ∪ derived, #1360) the
  // dueness count above reads, so held and due compose on one union: a pause link naming
  // a derived context holds exactly while it's active. The digest names the first
  // holding situation and counts the holds.
  const held = heldItemsBy(active, effectiveSituations);

  return {
    profileName,
    openEpisodeLine,
    doseCount,
    situationalActiveCount,
    heldCount: held.length,
    heldSituation: held[0]?.situation ?? null,
    derivedSituationLines,
    intakeKinds,
    todayGroups,
    activities,
    adherence,
    weightKg: weightRow?.weight_kg ?? null,
    newFlaggedBiomarkers,
    newDocumentLabels,
    // Last night's sleep (issue #1117) — null unless the opt-in is on and the data
    // is fresh; buildDigest renders a Sleep section only when present.
    sleep: gatherDigestSleep(profileId),
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
