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
  getStrengthByExercise,
  getCardioByActivity,
} from "../queries";
import { recentPRs, recentCardioPRs } from "../coaching";
import { getOutdoorPlans } from "../queries/weather-training";
import { trainingPaceLine } from "../queries/upcoming/plans";
import { collectRecentChanges } from "../queries/recent-changes";
import { getLightExposureLine } from "../queries/light-exposure";
import { getStepsDigestLines } from "../queries/steps-target";
import { groupUpcoming } from "../upcoming";
import { integrationToItem } from "../attention";
import { getIntegrationAttention } from "../queries/integrations";
import {
  mainSleepNights,
  sleepSessionDurationMinutes,
} from "../sleep-regularity";
import {
  countSituationalDue,
  doseDueOn,
  heldItemsBy,
} from "../supplement-schedule";
import {
  getActiveSituations,
  getSituationEvents,
  digestDemotionsForProfile,
  getNotifySchedule,
  getProfileSetting,
  setProfileSetting,
  getProfileSleepDigest,
  getTimezone,
  getPublicUrl,
} from "../settings";
import { situationHistoryResolver } from "../trend-annotations";
import { getIntakeDeltas } from "../intake-history";
import { currentEpisodeForProfile } from "../illness-episode";
import { episodeHeadline } from "../illness-episode-format";
import { dispatch } from "./index";
import {
  activitiesSurviveDemotion,
  collapsedTuneAction,
  recentChangeDemotions,
  sleepSurvivesDemotion,
  type DigestCategory,
} from "./digest-tune";
import type { RecentChangeCategory } from "../recent-changes";
import type { NotificationAction } from "./types";
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
import { collapsedOfferAction, offerTailNeedsRefresh } from "./offer-tail";
import { recommendWorkout } from "./recommend";
import { digestWorkoutLine } from "./workout-format";
import type { CoachingInput } from "../coaching";
import { updateMessageKeyboard } from "./telegram";
import { messageKeyboard } from "./telegram-render";
import {
  clearDigestTailPointer,
  getDigestTailPointer,
  setDigestTailPointer,
} from "../settings";
import { getOfferedIntakeForSlot } from "../queries/intake";

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
export function gatherDigestSleep(
  profileId: number,
  // Categories this profile's readers have all demoted (#1714). A demoted Sleep
  // section survives only on a night the #1712 verdict calls notable — the SAME
  // classification the line already prints, never a second threshold.
  demoted: readonly DigestCategory[] = []
): DigestSleep | null {
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

  if (
    !sleepSurvivesDemotion(
      demoted,
      signal.lastNightMin,
      Math.round(signal.baselineMin)
    )
  )
    return null;

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

// How many personal records were set on `date` — the notable predicate behind a
// demoted Activities section (#1797). It is the SAME recentPRs / recentCardioPRs pair
// the weekly recap and the Trends fitness lens read (#221), asked at a one-day window:
// their `within` is inclusive at both ends, so `withinDays = 0` means exactly `date`.
// Strength records are read per LOAD CONTEXT (#1610), matching the recap.
export function personalRecordsOn(profileId: number, date: string): number {
  return (
    recentPRs(getStrengthByExercise(profileId, true), date, 0).length +
    recentCardioPRs(getCardioByActivity(profileId, "km"), date, 0).length
  );
}

// Gather the digest facts for one profile. `since` bounds the "new since last
// digest" queries: the stored last-digest timestamp, or 24h ago on the first run
// so the first digest doesn't dump the entire history of flagged results.
export function gatherDigestInput(
  profileId: number,
  profileName: string,
  // The tick's already-gathered coaching input (#447), so the digest's workout preview
  // costs no second heavy per-profile scan. Omitted ⇒ recommendWorkout gathers fresh.
  gathered?: CoachingInput
): DigestInput {
  const td = today(profileId);
  const yd = shiftDateStr(td, -1);

  // Per-category demotion (#1714). One message, N readers: the preference is stored
  // per LOGIN, so what applies to this profile's single digest is the conservative
  // collapse — a category is demoted only when EVERY managing login declared it.
  const demoted = digestDemotionsForProfile(profileId);

  // Gathered up front: the Tune control has to know whether a Sleep section is in
  // play today before the return object is assembled.
  const sleep = gatherDigestSleep(profileId, demoted);

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
        doseDueOn(suppById.get(d.item_id)!, d, {
          date,
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
  // Broken syncs join the banded set (#1685) — the ONE place the digest learns about a
  // dead integration. They are built by the SAME integrationToItem the dashboard hero and
  // the Upcoming page render, from the SAME getIntegrationAttention list the Data → Review
  // badge counts, so the four surfaces cannot disagree about which sources are broken or
  // what to call them (#221). Deliberately appended AFTER `upcoming` is used for the dose
  // headline and the situational counts below: those read the date-scheduled set and must
  // not see a structural signal.
  //
  // They band as Today (no dueDate, no band override), which is the honest reading — a
  // sync that stopped is not scheduled for a date, it is broken NOW.
  const integrationItems =
    getIntegrationAttention(profileId).map(integrationToItem);
  const todayGroups = groupUpcoming([...upcoming, ...integrationItems], td);
  // The dose glance headline counts the DUE dose items collectUpcoming surfaced
  // (bus-honored + #558) — the same items the Today section bands over. No local
  // priority filter here any more (#1505): the "tracked, never pushed" exclusion now
  // lives in collectUpcoming's doseItems, the ONE shared model this reads, so the
  // digest count, the Upcoming rows, the aggregate and the hero can no longer
  // disagree about which doses are pushable (#221 — one question, one computation).
  const todayDoseIds = upcoming
    .filter((i) => i.domain === "dose" && i.doseId != null)
    .map((i) => i.doseId as number);
  const doseCount = todayDoseIds.length;

  // Yesterday: activities, supplement adherence x/y, weight if logged.
  const loggedActivities = getActivitiesByDate(profileId, yd);
  // Per-category demotion (#1714/#1797): a demoted Activities section survives only on
  // a day that set a personal record — the SAME recentPRs/recentCardioPRs
  // classification the weekly recap renders, never a second threshold. The PR reads
  // are paid for ONLY when the category is actually demoted and there is something to
  // filter, so an undemoted digest costs exactly what it did before.
  const prCount =
    demoted.includes("activities") && loggedActivities.length > 0
      ? personalRecordsOn(profileId, yd)
      : 0;
  const activities: DigestActivity[] = activitiesSurviveDemotion(
    demoted,
    prCount
  )
    ? loggedActivities.map((a) => ({
        title: a.title,
        type: a.type,
        durationMin: a.duration_min,
        distanceKm: a.distance_km,
      }))
    : [];
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
    date: td,
    isWorkoutDay: false,
    activeSituations: effectiveSituations,
  });
  // The digest has no login context (the notify tick runs per PROFILE), so weather
  // figures render in canonical °C — the default. A weather situation's activation is a
  // digest LINE only: it never becomes a send of its own (#1726's no-pushes boundary).
  const derivedLines = getDerivedSituationLines(profileId, td);
  const derivedSituationLines = [
    derivedLines.poorSleep,
    derivedLines.period,
    ...derivedLines.weather,
  ].filter((l): l is string => l != null);

  // Held items (#1296): active intake items currently suppressed by a pause situation,
  // via the SAME heldItemsBy computation the Supplements/Medications rows and the badge
  // use (#221). It reads the SAME effectiveSituations (declared ∪ derived, #1360) the
  // dueness count above reads, so held and due compose on one union: a pause link naming
  // a derived context holds exactly while it's active. The digest names the first
  // holding situation and counts the holds.
  const held = heldItemsBy(active, effectiveSituations);

  // Steps against the declared daily target (#1723 part 2) — one gather, two lines.
  const stepsLines = getStepsDigestLines(profileId, td);

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
    // Makes the broken-sync lines' hrefs tappable (#1685); empty when no public URL is
    // configured, in which case the lines still name the provider.
    deepLinkBase: getPublicUrl(),
    // Today's recommended workout as ONE line (#1712 §2), from the SAME recommendation
    // the dedicated nudge formats. The nudge is deliberately unchanged: the digest is a
    // 7am heads-up, the nudge is the actionable prompt with buttons later.
    // BARE variant (#1819 item 3): this line renders under the digest's own **Today**
    // heading, where the formatter's standalone "Today:" prefix restated it.
    workoutPreview: digestWorkoutLine(recommendWorkout(profileId, gathered), {
      standalone: false,
    }),
    // Weekly-progress phrase for the training band (#1819 item 4), over the SAME paced
    // target set the Upcoming training items are drawn from. Null when the profile has
    // declared no weekly targets.
    trainingPaceLine: trainingPaceLine(profileId),
    // The outdoor-session PLAN (#1724 part 5) — the same planningLine computation the
    // calm Upcoming item renders, as a This-week glance. It rides THIS message; no
    // dedicated send exists or is created. Empty on a week with no scarcity to plan
    // around, and honestly hedged past the reliable forecast horizon.
    weatherPlanLines: getOutdoorPlans(profileId, td).map((plan) => plan.line),
    // The weather-aware light window (#1723 part 1) — rendered from the already-synced
    // weather/UV cache, gated by the named favorable-conditions predicate. Null on a
    // rainy day, a day with no cached forecast, and for a profile that neither tracks a
    // light practice nor has a live sun surface. Rides this message; no send is created.
    lightExposureLine: getLightExposureLine(profileId, td),
    stepsTodayLine: stepsLines.today,
    activities,
    adherence,
    // Deltas (#1505 part 3): WHICH pushed obligations changed state, from the ONE
    // shared classifier every digest channel formats. Empty on a quiet window — the
    // digest doesn't invent news. Carried STRUCTURED rather than preformatted so
    // buildDigest can also merge the delta into the x/y fraction when the two state one
    // fact twice (#1819 item 6); it renders through the same `intakeDeltaLine` when
    // they diverge.
    intakeDeltas: getIntakeDeltas(profileId, td),
    // The guaranteed access tail (#1505). Scoped to the slot the digest is BUILT in;
    // the tick re-labels it at each boundary and the expansion re-scopes at tap, so a
    // morning-born keyboard never offers breakfast items at bedtime.
    ...(() => {
      const nowHhmm = zonedDateParts(getTimezone(profileId), new Date()).hhmm;
      const offered = getOfferedIntakeForSlot(profileId, nowHhmm);
      return {
        offerCount: offered.length,
        offerTail:
          offered.length > 0
            ? collapsedOfferAction(profileId, td, nowHhmm, offered.length)
            : null,
      };
    })(),
    weightKg: weightRow?.weight_kg ?? null,
    // Steps (#1723 part 2): yesterday's verdict against the declared daily target, and
    // the Today target line when the trailing average makes it informative. Both null
    // for a profile that has declared no target — the resting state.
    stepsLine: stepsLines.yesterday,
    newFlaggedBiomarkers,
    newDocumentLabels,
    // What else changed in the last 24 hours (#1713), from the ONE shared collector the
    // Household member card reads at 7 days. `labs` is EXCLUDED because the two fields
    // above already report newly-flagged lab results from the digest's own send cursor
    // — the same getCurrentFlaggedBiomarkers computation at a different window — and
    // collecting them here too would double-report one finding rather than add one.
    // Everything the digest was structurally blind to (out-of-range vitals, mood,
    // symptoms, overnight arrival) comes through here.
    ...(() => {
      const recent = collectRecentChanges(profileId, {
        sinceDays: 1,
        today: td,
        exclude: ["labs"],
        overflowLabel: "since yesterday",
        // Demoted categories surface only their notable entries. `flagged` implies
        // notable inside the collector, so the safety floor is structurally untouched
        // by any preference (#1714).
        demoted: recentChangeDemotions(demoted),
      });
      return {
        recentChangeLines: recent.lines,
        // What the ⚙️ Tune keyboard will offer: the categories present in TODAY's
        // message (pre-demotion), plus Sleep when the section is in play. The tap
        // re-resolves this against the TAPPING login's own preferences, exactly as the
        // offer tail re-resolves its slot — the collapsed button is login-independent.
        tuneTail: tuneTailFor(
          profileId,
          td,
          recent.presentCategories,
          sleep,
          activities.length > 0
        ),
      };
    })(),
    // Last night's sleep (issue #1117) — null unless the opt-in is on and the data
    // is fresh; buildDigest renders a Sleep section only when present.
    sleep,
  };
}

// The collapsed ⚙️ Tune action for today's message, or null when the message carries
// nothing tunable (#1714). Tuning is an escape hatch from lines you are actually
// receiving; offering it on a digest that has none would be a control with no subject.
// A reader who demoted everything reaches their toggles through the Settings mirror,
// which is exactly the role the design gives it.
function tuneTailFor(
  profileId: number,
  date: string,
  present: readonly RecentChangeCategory[],
  sleep: DigestSleep | null,
  hasActivities: boolean
): NotificationAction | null {
  return tunableFrom(present, sleep, hasActivities).length
    ? collapsedTuneAction(profileId, date)
    : null;
}

// The categories THIS message could tune: whatever the collector produced, plus each
// digest-owned section that is in play. Every collector category is tunable since
// #1797, so nothing is filtered out here any more — the digest simply never collects
// `labs` (it renders flagged results from its own send cursor instead), so `present`
// cannot contain it.
function tunableFrom(
  present: readonly RecentChangeCategory[],
  sleep: DigestSleep | null,
  hasActivities: boolean
): DigestCategory[] {
  return [
    ...present,
    ...(sleep ? (["sleep"] as const) : []),
    ...(hasActivities ? (["activities"] as const) : []),
  ];
}

// The categories TODAY's digest could tune, resolved fresh at TAP time — the offer
// tail's rule, one control over (#1505): a keyboard born in the morning is tapped
// whenever, so what it opens into is computed now rather than baked at send. Read
// WITHOUT any demotion so a category the tapping login has already silenced still
// appears in its own toggle and stays reversible on Telegram.
export function digestTunableCategories(
  profileId: number,
  date: string
): DigestCategory[] {
  const recent = collectRecentChanges(profileId, {
    sinceDays: 1,
    today: date,
    exclude: ["labs"],
  });
  return tunableFrom(
    recent.presentCategories,
    gatherDigestSleep(profileId),
    getActivitiesByDate(profileId, shiftDateStr(date, -1)).length > 0
  );
}

// Build + send this profile's morning digest for `date`. Returns whether a send
// failed. Marks the day done (per-profile/day dedup) whether it sent or found
// nothing to say, but only advances the "since" timestamp on a real send so
// unsent new items still surface tomorrow.
export async function runDigest(
  profileId: number,
  profileName: string,
  date: string,
  gathered?: CoachingInput
): Promise<{ failed: boolean }> {
  const dedupKey = "notify_last_digest";
  const model = buildDigest(
    gatherDigestInput(profileId, profileName, gathered)
  );
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

// The SILENT boundary refresh (issue #1505). Once per tick, per profile: if the
// digest we sent today is still carrying an offer tail whose slot label has gone
// stale, re-render the keyboard — collapsed, relabelled for the slot we are actually
// in now.
//
// WHY THIS IS NOT A SEND. It is one editMessageReplyMarkup on a message the user
// already received. Telegram does not notify on an edit, no new row appears in the
// chat, and the phone stays silent. That distinction is the whole reason the
// guaranteed-access tail can exist at all without violating the contact-consent rule:
// the system is allowed to keep an affordance it already gave accurate; it is not
// allowed to spend another interruption doing so.
//
// It always resets to COLLAPSED. An expanded keyboard from the previous slot is
// listing items that are no longer on offer, so leaving it open would be worse than
// closing it — and the collapse button exists as the manual equivalent for a user who
// expanded it and walked away.
//
// Three no-ops, each deliberate: no pointer (nothing sent today, or the digest had no
// tail), a pointer from a PREVIOUS day (day rollover strips the keyboard entirely
// rather than relabelling a stale day's message), and a slot that hasn't turned over
// (offerTailNeedsRefresh false → zero API calls, so the common tick costs nothing).
export async function refreshDigestOfferTail(profileId: number): Promise<void> {
  const pointer = getDigestTailPointer(profileId);
  if (!pointer) return;
  const date = today(profileId);
  const nowHhmm = zonedDateParts(getTimezone(profileId), new Date()).hhmm;

  if (pointer.date !== date) {
    // Day rollover: yesterday's keyboard must not stay tappable, because its tokens
    // carry yesterday's date and the expansion would refuse them anyway. Strip it and
    // forget the pointer so this runs once, not every tick forever.
    await updateMessageKeyboard(pointer.chatId, pointer.messageId, []).catch(
      (e) =>
        log.info("digest tail: rollover strip failed (ignored)", {
          profile: profileId,
          err: e instanceof Error ? e.message : String(e),
        })
    );
    clearDigestTailPointer(profileId);
    return;
  }
  if (!offerTailNeedsRefresh(pointer.renderedAt, nowHhmm)) return;

  const offered = getOfferedIntakeForSlot(profileId, nowHhmm);
  const actions =
    offered.length > 0
      ? [collapsedOfferAction(profileId, date, nowHhmm, offered.length)]
      : [];
  try {
    await updateMessageKeyboard(
      pointer.chatId,
      pointer.messageId,
      messageKeyboard({ title: "", body: "", actions })
    );
    setDigestTailPointer(profileId, { ...pointer, renderedAt: nowHhmm });
  } catch (e) {
    // Best-effort throughout: the digest already landed, and a failed relabel is a
    // cosmetic staleness, never a delivery failure.
    log.info("digest tail: refresh failed (ignored)", {
      profile: profileId,
      err: e instanceof Error ? e.message : String(e),
    });
  }
}
