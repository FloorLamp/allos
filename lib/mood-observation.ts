// The PURE detection half of the two mood coaching observations (issue #992):
//
//   1. the sustained LOW-MOOD window — a calm, dismissible note when mood has
//      trended low over a sustained window; and
//   2. the SLEEP↔MOOD bridge — ONE co-occurrence note when a sustained sleep-
//      regularity/duration drop overlaps that low-mood window.
//
// Both are COACHING tier only (#449): they join collectCoachingFindings, their
// prefixes are registered in RULE_FINDING_PREFIXES, and they NEVER notify and
// never reach the non-hideable hero. Copy stays observational and non-diagnostic
// — the bridge states co-occurrence ("the two often move together"), NEVER a
// causal or clinical claim, and neither observation prompts an instrument or a
// crisis resource (product-decided in #992: those escalations belong to #716 and
// #996, not the daily layer).
//
// Pure (no DB/clock); the input assembly lives in buildMoodFindings /
// buildSleepMoodBridgeFindings (lib/rule-findings.ts).

// dedupeKey namespaces for the suppression bus + the RULE_FINDING_PREFIXES registry.
export const MOOD_OBS_PREFIX = "mood-obs:";
export const SLEEP_MOOD_PREFIX = "sleep-mood:";

// The low-mood observation window and its gates: at least MIN_LOGS check-ins over
// the trailing WINDOW_DAYS whose mean valence sits at or below the threshold.
export const MOOD_LOW_WINDOW_DAYS = 14;
export const MOOD_LOW_MIN_LOGS = 7;
export const MOOD_LOW_MEAN_THRESHOLD = 2.5;

// Sleep-drop thresholds for the bridge: an SRI drop of ≥ this many points, or a
// nightly-duration drop of ≥ this many minutes, recent window vs the prior one.
export const SLEEP_MOOD_SRI_DROP_POINTS = 10;
export const SLEEP_MOOD_DURATION_DROP_MIN = 45;
// Minimum recorded nights per 14-day duration window for the comparison to mean
// anything (mirrors the SRI module's sparse-data caution).
export const SLEEP_MOOD_MIN_NIGHTS = 7;

// Episode key: anchored to the month the window ENDS in (#436 episode anchoring),
// so one dismissal silences the observation for that month and a genuinely new
// low stretch months later can resurface rather than being silenced forever.
export function lowMoodSignalKey(monthAnchor: string): string {
  return `${MOOD_OBS_PREFIX}low:${monthAnchor}`;
}

export function sleepMoodSignalKey(monthAnchor: string): string {
  return `${SLEEP_MOOD_PREFIX}co:${monthAnchor}`;
}

export interface MoodEntry {
  date: string; // YYYY-MM-DD
  valence: number; // 1..5
}

export interface LowMoodWindow {
  dedupeKey: string;
  title: string;
  detail: string;
  // Mean valence over the window's logged days, one decimal.
  meanValence: number;
  daysLogged: number;
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// Detect a sustained low-mood window over the trailing MOOD_LOW_WINDOW_DAYS
// ending at `today` (inclusive). `entries` may span any range; only in-window
// dates count. Emits ONLY when enough days are logged AND the window mean sits at
// or below the threshold — sparse data or an ordinary mixed stretch stays silent.
export function detectLowMoodWindow(
  entries: readonly MoodEntry[],
  today: string,
  windowStart: string
): LowMoodWindow | null {
  const inWindow = entries.filter(
    (e) => e.date >= windowStart && e.date <= today
  );
  if (inWindow.length < MOOD_LOW_MIN_LOGS) return null;
  const m = mean(inWindow.map((e) => e.valence));
  if (m > MOOD_LOW_MEAN_THRESHOLD) return null;
  const rounded = Math.round(m * 10) / 10;
  return {
    dedupeKey: lowMoodSignalKey(today.slice(0, 7)),
    title: "Mood has been low lately",
    // Calm, observational, non-diagnostic — states the data and prescribes
    // nothing. Deliberately no instrument prompt and no crisis linkage (#992).
    detail:
      `Over the last two weeks your check-ins have averaged ${rounded} out of 5 ` +
      `across ${inWindow.length} days. Just an observation from your own log — ` +
      `worth a look alongside sleep, stress, and what's been going on.`,
    meanValence: rounded,
    daysLogged: inWindow.length,
  };
}

// ---- The sleep↔mood bridge (#992's first-class deliverable) -----------------

export interface SleepMoodInput {
  // The already-detected low-mood window (null → no bridge, ever).
  lowMood: LowMoodWindow | null;
  // Sleep Regularity Index over the recent window vs the prior one (null when
  // either window lacks enough nights to compute).
  recentSri: number | null;
  priorSri: number | null;
  // Mean nightly sleep minutes, recent 14 days vs the prior 14 (null when a
  // window has fewer than SLEEP_MOOD_MIN_NIGHTS recorded nights).
  recentAvgSleepMin: number | null;
  priorAvgSleepMin: number | null;
}

export interface SleepMoodObservation {
  dedupeKey: string;
  title: string;
  detail: string;
}

// Mean of the values on dates inside [start, end], or null below the night gate.
// Shared by the builder so the two 14-day duration windows are computed one way.
export function meanNightlySleepMin(
  nights: readonly { date: string; value: number }[],
  start: string,
  end: string,
  minNights: number = SLEEP_MOOD_MIN_NIGHTS
): number | null {
  const vals = nights
    .filter((n) => n.date >= start && n.date <= end)
    .map((n) => n.value);
  if (vals.length < minNights) return null;
  return mean(vals);
}

// Decide the co-occurrence note. Fires ONLY when the low-mood window is present
// AND at least one sleep signal dropped: SRI down ≥ SLEEP_MOOD_SRI_DROP_POINTS,
// or nightly duration down ≥ SLEEP_MOOD_DURATION_DROP_MIN — each requiring BOTH
// of its windows to be computable. Either series alone (low mood with steady
// sleep, or a sleep dip with steady mood) stays silent. Co-occurrence phrasing
// only — deliberately no directional/causal claim (#992's design choice).
export function decideSleepMoodBridge(
  input: SleepMoodInput,
  monthAnchor: string
): SleepMoodObservation | null {
  if (!input.lowMood) return null;

  const sriDrop =
    input.recentSri != null && input.priorSri != null
      ? input.priorSri - input.recentSri
      : null;
  const durationDrop =
    input.recentAvgSleepMin != null && input.priorAvgSleepMin != null
      ? input.priorAvgSleepMin - input.recentAvgSleepMin
      : null;

  const sriDropped = sriDrop != null && sriDrop >= SLEEP_MOOD_SRI_DROP_POINTS;
  const durationDropped =
    durationDrop != null && durationDrop >= SLEEP_MOOD_DURATION_DROP_MIN;
  if (!sriDropped && !durationDropped) return null;

  const sleepFact = sriDropped
    ? `your sleep regularity dropped about ${Math.round(sriDrop!)} points`
    : `you've been sleeping about ${Math.round(durationDrop!)} minutes less per night`;

  return {
    dedupeKey: sleepMoodSignalKey(monthAnchor),
    title: "Sleep and mood moved together",
    detail:
      `Over the same stretch your mood check-ins have been low, ${sleepFact} ` +
      `compared with the weeks before. The two often move together — just a ` +
      `pattern from your own data, not a diagnosis.`,
  };
}
