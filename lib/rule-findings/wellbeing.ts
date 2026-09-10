// Wellbeing rule findings (#2962).
//
// The mood observation and the sleep-mood bridge share ONE low-mood window verdict
// (lowMoodWindowFor below), so they cannot disagree about whether mood has been low;
// that shared verdict is why they cannot be separated. The clock-skew and paired-factor
// observations join them as the other readings taken from what the person recorded
// about themselves rather than from a measurement of their training or intake.

import { getProfileAge } from "../settings";
import { isMinor } from "../life-stage";
import {
  decidePairedObservation,
  pairedObservationsFor,
} from "../paired-observations";
import {
  factorDaysReader,
  gatherPairedNights,
  outcomeSeriesReader,
} from "../queries/paired-observations";
import {
  detectLowMoodWindow,
  decideSleepMoodBridge,
  meanNightlySleepMin,
  MOOD_LOW_WINDOW_DAYS,
  type LowMoodWindow,
} from "../mood-observation";
import { getMoodLogs, getMetricDailyTotals } from "../queries";
import { getSleepRegularityDrop } from "../queries/situation-impact";
import {
  getSuspectSleepSessions,
  SLEEP_SKEW_HISTORY_DAYS,
} from "../queries/sleep-clock-skew";
import { sleepClockSkewSignalKey } from "../sleep-clock-skew";
import { activityProvenanceLabel } from "../training-log-format";
import { shiftDateStr } from "../date";
import { FINDING_DASHBOARD_RELEVANCE, type Finding } from "../findings";

// ---- Wellbeing (#992): the sustained low-mood observation ------------------

// The ONE low-mood detection both mood builders share (one question, one
// computation): the low-mood finding and the sleep↔mood bridge key on the same
// window verdict, so they can never disagree about whether mood "has been low".
function lowMoodWindowFor(
  profileId: number,
  today: string
): LowMoodWindow | null {
  const windowStart = shiftDateStr(today, -(MOOD_LOW_WINDOW_DAYS - 1));
  return detectLowMoodWindow(
    getMoodLogs(profileId, windowStart).map((m) => ({
      date: m.date,
      valence: m.valence,
    })),
    today,
    windowStart
  );
}

// A calm, coaching-tier observation when mood check-ins have trended low over a
// sustained window. Coaching tier ONLY (#449, product-decided in #992): it joins
// collectCoachingFindings, its dedupeKey rides the shared suppression bus
// (MOOD_OBS_PREFIX is registered in RULE_FINDING_PREFIXES), and it NEVER notifies
// / never reaches the hero. The copy is observational and non-diagnostic — no
// instrument prompt, no crisis linkage, no escalation of any kind (those belong
// to #716/#996, never the daily layer). No owned SQL added here (reads through
// the profile-scoped getMoodLogs).
export function buildMoodFindings(profileId: number, today: string): Finding[] {
  const low = lowMoodWindowFor(profileId, today);
  if (!low) return [];
  return [
    {
      domain: "mood-obs",
      dedupeKey: low.dedupeKey,
      title: low.title,
      detail: low.detail,
      // Calm FYI — a neutral observation from the user's own log, never an alarm.
      tone: "info",
      // This class's ONLY surface is the dashboard rollup (#449 inverted: no
      // origin tab renders it), so it declares rollup reach explicitly — the
      // tone-derived default would leave it rendering nowhere (#3129).
      dashboardRelevance: FINDING_DASHBOARD_RELEVANCE.review,
      evidence:
        "From your own daily check-ins — a subjective self-rating, not a screen " +
        "or a diagnosis.",
      actionHref: "/trends#body",
      actionLabel: "View mood trend",
    },
  ];
}

// ---- Sleep clock skew (#4299): the source's instants vs the body's heart rate ----

// ONE coaching-tier observation when a synced sleep session's stored instants disagree
// with the `hr_minutes` the same database holds across them — the Fitbit/Health Connect
// sighting where every night after a return east was stamped +6h and Allos printed
// "Bed time 5:39 AM" as fact.
//
// ONE finding PER EPISODE, not per night. A source whose clock reference has gone stale
// mis-stamps every night until it heals, so the key is anchored to the OLDEST suspect
// night still in the window: a dismissal covers the run rather than being re-minted each
// morning, and the fan-out is bounded by construction rather than by a cap.
//
// The judgement is NOT here — it is the pure detector in lib/sleep-clock-skew.ts, keyed
// on the heart-rate contradiction and on nothing else, so a genuinely shifted night (real
// jet lag, whose HR agrees with its clocks) never reaches this builder. A recorded
// timezone switch nearby only adds a SENTENCE to copy that already exists.
//
// Coaching tier ONLY (#449): it joins collectCoachingFindings, SLEEP_SKEW_PREFIX is
// registered in RULE_FINDING_PREFIXES, and it NEVER notifies and never reaches Now — a
// source's clock carries no obligation. No owned SQL here (reads through the
// profile-scoped gather).
export function buildSleepClockSkewFindings(
  profileId: number,
  today: string
): Finding[] {
  const suspect = getSuspectSleepSessions(
    profileId,
    shiftDateStr(today, -SLEEP_SKEW_HISTORY_DAYS)
  );
  if (suspect.length === 0) return [];
  // The gather orders newest-first, so the newest session carries the quoted evidence
  // and the last one anchors the episode.
  const newest = suspect[0];
  const firstWakeDay = suspect[suspect.length - 1].wakeDay;
  const source = activityProvenanceLabel(newest.source);
  const nights =
    suspect.length === 1
      ? "One recorded night's"
      : `${suspect.length} recorded nights'`;
  return [
    {
      domain: "sleep-clock-skew",
      dedupeKey: sleepClockSkewSignalKey(firstWakeDay),
      title: `${nights} sleep times disagree with your heart rate`,
      detail:
        // Two readings caught these nights, and each has its own true sentence. The
        // median reading can name an equally long window elsewhere holding the
        // overnight low; on a run finding no such window exists — that absence is why
        // the median reading missed it — so it names the stretch inside the window
        // instead (#5020).
        (newest.evidence.awakeRun
          ? // No duration in this sentence, for the same reason there is no offset in
            // the other one: "a two-hour stretch" beside "the clock times may not be"
            // reads as a claim about how far off the clock is, and nothing here
            // measures that.
            `Across the newest of them part of the recorded window ran at ` +
            `${newest.evidence.awakeRun.bpm} bpm — a daytime level — while the window ` +
            `as a whole sat at ${newest.evidence.claimedBpm} bpm. ` +
            `The durations look right; the clock times ${source} recorded may not be.`
          : `Across the newest of them your heart rate sat at ${newest.evidence.claimedBpm} bpm, ` +
            `while an equally long window earlier the same day sat at ${newest.evidence.troughBpm} bpm — ` +
            `the overnight low. The durations look right; the clock times ${source} recorded may not be.`) +
        (newest.nearTimezoneSwitch
          ? " Your travel log records a timezone change around then."
          : ""),
      // Calm FYI about a source, never an alarm about the person.
      tone: "info",
      // This class's only surface is the dashboard rollup — the Sleep page hedges the
      // times and offers the delete, but it does not render the finding (#3129).
      dashboardRelevance: FINDING_DASHBOARD_RELEVANCE.review,
      evidence:
        "Your own heart-rate record, from the same source and the same nights.",
      actionHref: "/sleep",
      actionLabel: "Review sleep",
    },
  ];
}

// ---- Wellbeing (#992): the sleep↔mood co-occurrence bridge ------------------

// ONE coaching-tier finding when a sustained sleep-regularity/duration drop
// CO-OCCURS with the low-mood window above. Deliberately a CO-OCCURRENCE note —
// "the two often move together" — never a causal or directional claim (#992's
// design choice). Sleep inputs reuse the SAME computations the Trends sleep
// surfaces render: the shared trailing SRI comparison decision, and the
// sleep_min daily totals for the duration windows — no second sleep engine.
// Coaching tier ONLY (#449): joins collectCoachingFindings, SLEEP_MOOD_PREFIX is
// registered, never a notification, never the hero. No owned SQL added here.
export function buildSleepMoodBridgeFindings(
  profileId: number,
  today: string
): Finding[] {
  const low = lowMoodWindowFor(profileId, today);
  if (!low) return [];

  // Mean nightly duration, recent 14 days vs the prior 14 — the same daily
  // totals series the body census sleep chart renders.
  const nights = getMetricDailyTotals(profileId, "sleep_min");
  const recentStart = shiftDateStr(today, -13);
  const priorEnd = shiftDateStr(today, -14);
  const priorStart = shiftDateStr(today, -27);

  const obs = decideSleepMoodBridge(
    {
      lowMood: low,
      regularityDrop: getSleepRegularityDrop(profileId, today),
      recentAvgSleepMin: meanNightlySleepMin(nights, recentStart, today),
      priorAvgSleepMin: meanNightlySleepMin(nights, priorStart, priorEnd),
    },
    today.slice(0, 7)
  );
  if (!obs) return [];
  return [
    {
      domain: "sleep-mood",
      dedupeKey: obs.dedupeKey,
      title: obs.title,
      detail: obs.detail,
      // Calm FYI — a pattern note from the user's own data, never an alarm.
      tone: "info",
      // Rollup-only reach, declared explicitly for the same reason as the
      // low-mood note above (#3129).
      dashboardRelevance: FINDING_DASHBOARD_RELEVANCE.review,
      evidence:
        "Co-occurrence in your own data — sleep and mood often move together. " +
        "Not a causal claim and not a diagnosis.",
      actionHref: "/trends#body",
      actionLabel: "View trends",
    },
  ];
}

// ---- Paired observations (#2177): the declared factor × outcome registry ----

// One calm coaching finding per DECLARED pair whose two arms both cleared the
// per-arm night minimum and whose means differ by at least that pair's fixed floor.
// The registry (lib/paired-observations) is the multiplicity control — this builder
// runs exactly the pairs someone argued for in writing, never a search — and the
// decision, the gates and every word of the copy are pure and live there.
//
// Coaching tier ONLY (#449): joins collectCoachingFindings, PAIRED_OBS_PREFIX is
// registered, never a notification, never the hero, never an obligation. Keys are
// month-anchored (#436) and declare their stem as `episodeFamily` (#2543), so a
// dismissal silences the pair for the month and repeat declines are read as an answer
// (#2386) rather than accumulating unheard.
//
// The adult gate is asked ONCE, in the pure entry selection both this builder and its
// tests call, so a second caller cannot walk past it (#2107); an alcohol-conditioned
// pair simply is not in the list for a known minor. No owned SQL added here.
export function buildPairedObservationFindings(
  profileId: number,
  today: string
): Finding[] {
  const entries = pairedObservationsFor({
    isKnownMinor: isMinor(getProfileAge(profileId)),
  });
  if (entries.length === 0) return [];
  const series = outcomeSeriesReader(profileId);
  // One memo for the factor side too (#4775): three entries now share the alcohol
  // factor over one window, and the factor read happens before every entry's
  // short-circuit — so without this the registry costs a range scan per entry.
  const days = factorDaysReader(profileId);
  const monthAnchor = today.slice(0, 7);
  const out: Finding[] = [];
  for (const entry of entries) {
    const nights = gatherPairedNights(profileId, entry, today, series, days);
    const verdict = decidePairedObservation(entry, nights, today, monthAnchor);
    if (!verdict) continue;
    out.push({
      domain: "paired-obs",
      dedupeKey: verdict.dedupeKey,
      episodeFamily: verdict.episodeFamily,
      title: verdict.title,
      detail: verdict.detail,
      // Calm FYI — a co-occurrence in the user's own logs, never an alarm.
      tone: "info",
      // The module's declared reach is the rollup and nothing more, so the
      // rollup's floor must be cleared explicitly (#3129).
      dashboardRelevance: FINDING_DASHBOARD_RELEVANCE.review,
      // The decision sentence already owns both arm sizes and the disclaimer.
      evidence: null,
      actionHref: entry.actionHref,
      actionLabel: entry.actionLabel,
    });
  }
  return out;
}
