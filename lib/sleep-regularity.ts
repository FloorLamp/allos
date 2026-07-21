// Sleep Regularity Index (SRI) + companion consistency metrics (issue #160).
//
// WHY regularity, not just duration: the literature finds that the *consistency*
// of sleep/wake timing predicts mortality better than sleep duration (Windred
// et al., "Sleep regularity is a stronger predictor of mortality risk than sleep
// duration", SLEEP 2023, UK Biobank; the SRI itself is from Phillips et al., Sci
// Rep 2017). This module is PURE — no DB, no network, no `Date.now()` — so the
// same math runs in the Trends surface, the weekly recap, and the unit tests.
//
// ── The published SRI formula ────────────────────────────────────────────────
// Divide each day into M equal epochs at fixed clock positions. Let s(i,j) ∈
// {0=awake, 1=asleep} be the state at epoch j of day i. Over N days:
//
//   SRI = -100 + (200 / (M·(N-1))) · Σ_{i=1}^{N-1} Σ_{j=1}^{M} δ( s(i,j), s(i+1,j) )
//
// where δ(a,b)=1 when the two states match and 0 otherwise. Equivalently:
//
//   SRI = -100 + 200 · ( fraction of consecutive-day epoch pairs in the SAME state )
//
// SRI = 100 means a perfectly reproducible schedule (identical state at every
// clock time on consecutive days); 0 is random; -100 is perfectly anti-phase.
// We use per-MINUTE epochs (M = 1440), matching "same clock time on consecutive
// days" at the finest resolution the stored windows support.
//
// ── Day anchoring (noon) ─────────────────────────────────────────────────────
// We index the 24h "sleep-day" from NOON to NOON so a single night's sleep falls
// entirely inside one day (evening onset + morning offset), instead of being cut
// in half at midnight. Because the SRI compares the SAME clock minute on
// consecutive days, its value is invariant to where the day boundary is placed
// for interior days — noon anchoring only makes the missing-night bookkeeping
// clean (each sleep-day maps to exactly one recorded night). Epoch j therefore
// corresponds to clock minute (720 + j) mod 1440: epoch 0 = 12:00, epoch 720 =
// 00:00, epoch 1439 = 11:59.
//
// ── Missing nights (per the published method, NOT "absence = wake") ───────────
// The SRI was defined over CONTINUOUS actigraphy, where every epoch has an
// observed state. With discrete sleep sessions a gap means "unknown", not "awake"
// — treating an absent night as all-wake would fabricate regularity. So we only
// form a consecutive-day PAIR when BOTH days are adjacent calendar days that each
// have a recorded main sleep session; a gap contributes no pair and is simply
// skipped. Under a minimum-data gate this keeps SRI meaningful on sparse data.
//
// ── Timezone ─────────────────────────────────────────────────────────────────
// All clock math is done in the PROFILE timezone by converting each stored
// absolute instant to profile-local wall-clock (date + minute-of-day). Because we
// bucket by wall clock rather than by an absolute offset, DST transitions and
// travel are handled correctly: a 23:00-local bedtime is regular in clock time
// even across a spring-forward, where the absolute duration of that night is 23h.

import { shiftDateStr, weekdayOfDateStr, zonedDateParts } from "./date";

// One recorded sleep session. `start`/`end` are absolute ISO instants (the same
// zone-independent anchors stored in metric_samples.start_time/end_time). `source`
// carries provenance so a future multi-source world (Oura, #140) can be made
// source-aware (#14) without changing this signature. `type` is an OPTIONAL
// provider-supplied session label (Oura's `long_sleep` / `late_nap` / `rest`);
// when present the main-sleep classifier (#1118) honors it, else the heuristic
// decides. Nothing stores `type` today (no schema change — #1118), so DB reads
// leave it undefined and the heuristic covers Health Connect.
export interface SleepSession {
  start: string;
  end: string;
  source?: string | null;
  type?: string | null;
}

// ── Main overnight sleep vs naps (issue #1118) ───────────────────────────────
// A wake-day can hold several recorded sleep sessions: one MAIN overnight sleep
// plus optional naps. The two sources disagree — Oura ingests only `long_sleep`
// (naps dropped at ingest), while Health Connect ingests EVERY session unlabeled
// and the daily `sleep_min` total SUMS them (sleep_min is additive — see
// metric-buckets), so an overnight + an afternoon nap read as one inflated night.
// That masks overnight deprivation in the poor-sleep rest trigger and poisons any
// wake-time / last-night figure. This PURE classifier picks the ONE main overnight
// session per wake-day from the session windows already stored — no new column, no
// ingest change, no migration (consistent with the storage stance). Consumers that
// mean "the night" (the rest trigger; a wake-time median; a last-night hero) read
// the main session; SRI (#160) DELIBERATELY does NOT route through this — a nap
// genuinely IS asleep-state at that clock minute, which is what the published SRI
// measures, so computeSleepRegularity keeps every session's epochs (see the guard
// test). Do not "fix" SRI to exclude naps.

// Classify a provider-supplied session `type` (Oura's `long_sleep` / `late_nap` /
// `early_nap` / `rest`) as the MAIN overnight sleep, a nap, or unknown (in which
// case the heuristic decides). Unknown labels fall through to the heuristic too.
function sessionKind(type: string | null | undefined): "main" | "nap" | null {
  if (type == null) return null;
  const t = type.trim().toLowerCase();
  if (t === "long_sleep" || t === "main" || t === "main_sleep" || t === "sleep")
    return "main";
  if (t === "rest" || t.includes("nap")) return "nap";
  return null;
}

// Milliseconds a session spans. Callers pass only validated start<end sessions.
function sessionMs(s: SleepSession): number {
  return new Date(s.end).getTime() - new Date(s.start).getTime();
}

// Pick the MAIN overnight sleep session from ONE wake-day's sessions, or null when
// the day holds no main sleep (empty input, all-invalid windows, or every session
// provider-labeled a nap). Everything else that day is a nap.
//
// When a source pre-labels type (Oura), HONOR it: the main session is the longest
// session the source calls a main sleep, and provider-labeled naps are excluded
// outright. Otherwise (Health Connect, unlabeled) the heuristic picks the LONGEST
// session, tie-broken toward the one ending EARLIEST — the morning window, i.e. the
// session that follows the long daytime awake gap — so a same-duration afternoon
// nap never outranks the overnight fragment that ends at dawn.
export function mainSleepSession<T extends SleepSession>(
  sessionsForWakeDay: T[]
): T | null {
  const valid = sessionsForWakeDay.filter((s) => {
    const a = new Date(s.start).getTime();
    const b = new Date(s.end).getTime();
    return Number.isFinite(a) && Number.isFinite(b) && b > a;
  });
  if (valid.length === 0) return null;

  const mains = valid.filter((s) => sessionKind(s.type) === "main");
  const candidates =
    mains.length > 0
      ? mains
      : valid.filter((s) => sessionKind(s.type) !== "nap");
  if (candidates.length === 0) return null; // every session is a labeled nap

  return candidates.reduce((best, s) => {
    const bd = sessionMs(best);
    const sd = sessionMs(s);
    if (sd !== bd) return sd > bd ? s : best;
    // Tie on duration → prefer the session ending earlier (the morning window).
    const be = new Date(best.end).getTime();
    const se = new Date(s.end).getTime();
    if (se !== be) return se < be ? s : best;
    // Fully tied → keep the earlier-starting session for a deterministic result.
    return new Date(s.start).getTime() < new Date(best.start).getTime()
      ? s
      : best;
  });
}

// Group sessions by profile-local wake-day (calendar date of the session END, the
// same anchor buildNights uses) and return the MAIN overnight session per day
// (mainSleepSession), naps dropped, oldest→newest. This is the "one night per day"
// series the poor-sleep rest trigger and any last-night / wake-time reader consume
// so a same-day nap can't mask overnight deprivation — WITHOUT touching SRI, which
// still sees every session.
export function mainSleepNights(
  sessions: SleepSession[],
  tz: string
): { wakeDay: string; start: string; end: string; durationMin: number }[] {
  const byDay = new Map<string, SleepSession[]>();
  for (const s of sessions) {
    const startMs = new Date(s.start).getTime();
    const endMs = new Date(s.end).getTime();
    if (
      !Number.isFinite(startMs) ||
      !Number.isFinite(endMs) ||
      endMs <= startMs
    )
      continue;
    const wakeDay = zonedDateParts(tz, new Date(s.end)).date;
    const arr = byDay.get(wakeDay);
    if (arr) arr.push(s);
    else byDay.set(wakeDay, [s]);
  }
  const out: {
    wakeDay: string;
    start: string;
    end: string;
    durationMin: number;
  }[] = [];
  for (const [wakeDay, group] of byDay) {
    const main = mainSleepSession(group);
    if (!main) continue;
    out.push({
      wakeDay,
      start: main.start,
      end: main.end,
      durationMin: Math.round(sessionMs(main) / 60000),
    });
  }
  return out.sort((a, b) => (a.wakeDay < b.wakeDay ? -1 : 1));
}

export interface SleepRegularityOptions {
  // Anchor date (YYYY-MM-DD, profile-local). The rolling window ends here
  // (inclusive). Defaults to the latest recorded wake-day in the data.
  asOf?: string;
  // Rolling window length in days. Default 28 (four weeks).
  windowDays?: number;
  // Minimum recorded nights within the window below which SRI is not emitted
  // (sparse data makes it meaningless). Default 14.
  minNights?: number;
}

export interface SleepRegularity {
  // The Sleep Regularity Index, −100..100, rounded to one decimal.
  sri: number;
  // Recorded nights that fell inside the window.
  nights: number;
  // Consecutive-day pairs that contributed to the SRI (adjacent observed nights).
  pairs: number;
  // Window bounds actually used (profile-local YYYY-MM-DD, inclusive).
  windowStart: string;
  windowEnd: string;
  // Standard deviation (minutes) of clock bedtime / waketime across the nights.
  bedtimeSdMin: number;
  waketimeSdMin: number;
  // Social jetlag: absolute weekend-vs-weekday mid-sleep shift (minutes), or null
  // when the window lacks at least one weekday AND one weekend night.
  socialJetlagMin: number | null;
}

const EPOCHS_PER_DAY = 1440; // one epoch per clock minute
const NOON = 720; // minute-of-day of 12:00, the sleep-day anchor

// Minute-of-day (0..1439) from an "HH:MM" wall-clock string.
function minuteOfDay(hhmm: string): number {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

// Clock minute-of-day re-expressed relative to noon (12:00 → 0, 23:00 → 660,
// 00:00 → 720, 07:00 → 1140). This keeps a normal evening-to-morning night
// CONTIGUOUS (no wrap at midnight), so plain arithmetic mean / SD of bed and wake
// times are well-defined without circular statistics.
function noonRelative(minOfDay: number): number {
  return (minOfDay - NOON + EPOCHS_PER_DAY) % EPOCHS_PER_DAY;
}

// Population standard deviation. Callers only reach it with ≥ 2 values (the
// minimum-nights gate guarantees it); returns 0 for < 2.
function stdDev(values: number[]): number {
  if (values.length < 2) return 0;
  const m = values.reduce((a, b) => a + b, 0) / values.length;
  const variance = values.reduce((a, b) => a + (b - m) ** 2, 0) / values.length;
  return Math.sqrt(variance);
}

function mean(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// A recorded night reduced to its profile-local timing facts.
interface Night {
  wakeDay: string; // local calendar date of the session END (the wake-up day)
  bedMin: number; // clock minute-of-day of sleep onset (local)
  wakeMin: number; // clock minute-of-day of wake (local)
  durationMin: number; // wall-clock minutes asleep (main session)
}

// Wall-clock (date + minute-of-day) of an absolute instant in `tz`.
function localParts(iso: string, tz: string): { date: string; min: number } {
  const p = zonedDateParts(tz, new Date(iso));
  return { date: p.date, min: minuteOfDay(p.hhmm) };
}

// Mark the asleep minutes of one session onto per-calendar-date bitmaps (keyed by
// local date), walking whatever calendar dates the session spans in wall clock.
function markAsleep(
  grid: Map<string, Uint8Array>,
  startDate: string,
  startMin: number,
  endDate: string,
  endMin: number
): void {
  const get = (d: string) => {
    let a = grid.get(d);
    if (!a) {
      a = new Uint8Array(EPOCHS_PER_DAY);
      grid.set(d, a);
    }
    return a;
  };
  if (startDate === endDate) {
    const a = get(startDate);
    for (let m = startMin; m < endMin; m++) a[m] = 1;
    return;
  }
  // First (partial) date: onset → midnight.
  const first = get(startDate);
  for (let m = startMin; m < EPOCHS_PER_DAY; m++) first[m] = 1;
  // Any whole dates strictly between (a normal night has none; guarded/capped).
  let d = shiftDateStr(startDate, 1);
  let guard = 0;
  while (d < endDate && guard++ < 3) {
    get(d).fill(1);
    d = shiftDateStr(d, 1);
  }
  // Last (partial) date: midnight → offset.
  const last = get(endDate);
  for (let m = 0; m < endMin; m++) last[m] = 1;
}

// Reduce raw sessions to (a) per-calendar-date asleep bitmaps built from ALL
// sessions and (b) one "main" (longest) night per wake-day for the companion
// timing metrics and the observed-night set.
function buildNights(
  sessions: SleepSession[],
  tz: string
): { grid: Map<string, Uint8Array>; nightsByDay: Map<string, Night> } {
  const grid = new Map<string, Uint8Array>();
  const nightsByDay = new Map<string, Night>();
  for (const s of sessions) {
    const startMs = new Date(s.start).getTime();
    const endMs = new Date(s.end).getTime();
    if (Number.isNaN(startMs) || Number.isNaN(endMs) || endMs <= startMs)
      continue;
    const start = localParts(s.start, tz);
    const end = localParts(s.end, tz);
    markAsleep(grid, start.date, start.min, end.date, end.min);
    const durationMin = Math.round((endMs - startMs) / 60000);
    const wakeDay = end.date;
    const existing = nightsByDay.get(wakeDay);
    // One night per wake-day: keep the LONGEST session as the "main" sleep so a
    // short nap doesn't define that night's bed/wake timing.
    if (!existing || durationMin > existing.durationMin) {
      nightsByDay.set(wakeDay, {
        wakeDay,
        bedMin: start.min,
        wakeMin: end.min,
        durationMin,
      });
    }
  }
  return { grid, nightsByDay };
}

// The 1440-epoch noon-anchored state array for sleep-day `wakeDay`: the evening
// half comes from the previous calendar date's 12:00–23:59, the morning half from
// the wake-day's 00:00–11:59. Absent bitmaps read as all-awake.
function sleepDayEpochs(
  grid: Map<string, Uint8Array>,
  wakeDay: string
): Uint8Array {
  const out = new Uint8Array(EPOCHS_PER_DAY);
  const evening = grid.get(shiftDateStr(wakeDay, -1));
  const morning = grid.get(wakeDay);
  if (evening) for (let j = 0; j < NOON; j++) out[j] = evening[NOON + j];
  if (morning) for (let j = 0; j < NOON; j++) out[NOON + j] = morning[j];
  return out;
}

// Compute the SRI + companions over the rolling window ending at `asOf`. Returns
// null when fewer than `minNights` nights fall in the window, or when no adjacent
// observed pair exists (nothing to compare).
export function computeSleepRegularity(
  sessions: SleepSession[],
  tz: string,
  opts: SleepRegularityOptions = {}
): SleepRegularity | null {
  const windowDays = opts.windowDays ?? 28;
  const minNights = opts.minNights ?? 14;

  const { grid, nightsByDay } = buildNights(sessions, tz);
  if (nightsByDay.size === 0) return null;

  const allDays = [...nightsByDay.keys()].sort();
  const asOf = opts.asOf ?? allDays[allDays.length - 1];
  const windowStart = shiftDateStr(asOf, -(windowDays - 1));

  // Observed nights inside the window, ascending.
  const observed = allDays.filter((d) => d >= windowStart && d <= asOf);
  if (observed.length < minNights) return null;

  // SRI: sum epoch matches over adjacent observed-day pairs only (a gap => no
  // pair; absence is never treated as wake).
  const observedSet = new Set(observed);
  let matches = 0;
  let pairs = 0;
  const epochCache = new Map<string, Uint8Array>();
  const epochsFor = (d: string) => {
    let e = epochCache.get(d);
    if (!e) {
      e = sleepDayEpochs(grid, d);
      epochCache.set(d, e);
    }
    return e;
  };
  for (const d of observed) {
    const next = shiftDateStr(d, 1);
    if (!observedSet.has(next)) continue; // missing night → skip the pair
    const a = epochsFor(d);
    const b = epochsFor(next);
    for (let j = 0; j < EPOCHS_PER_DAY; j++) if (a[j] === b[j]) matches++;
    pairs++;
  }
  if (pairs === 0) return null;
  const sri = -100 + 200 * (matches / (pairs * EPOCHS_PER_DAY));

  // Companions over the SAME observed nights.
  const nights = observed.map((d) => nightsByDay.get(d)!);
  const bedNoonRel = nights.map((n) => noonRelative(n.bedMin));
  const wakeNoonRel = nights.map((n) => noonRelative(n.wakeMin));
  const bedtimeSdMin = stdDev(bedNoonRel);
  const waketimeSdMin = stdDev(wakeNoonRel);

  // Social jetlag: |mean weekend mid-sleep − mean weekday mid-sleep|. A night is
  // "weekend" when its wake-day is Saturday or Sunday (free-day mornings). Mid-
  // sleep is bedtime + half the sleep duration, in noon-relative minutes so it
  // stays contiguous across midnight.
  const weekendMid: number[] = [];
  const weekdayMid: number[] = [];
  for (const n of nights) {
    const mid = noonRelative(n.bedMin) + n.durationMin / 2;
    const dow = weekdayOfDateStr(n.wakeDay); // 0=Sun … 6=Sat
    if (dow === 0 || dow === 6) weekendMid.push(mid);
    else weekdayMid.push(mid);
  }
  const socialJetlagMin =
    weekendMid.length > 0 && weekdayMid.length > 0
      ? Math.abs(mean(weekendMid) - mean(weekdayMid))
      : null;

  return {
    sri: Math.round(sri * 10) / 10,
    nights: observed.length,
    pairs,
    windowStart,
    windowEnd: asOf,
    bedtimeSdMin: Math.round(bedtimeSdMin),
    waketimeSdMin: Math.round(waketimeSdMin),
    socialJetlagMin:
      socialJetlagMin == null ? null : Math.round(socialJetlagMin),
  };
}

// A rolling SRI series: SRI computed over the trailing `windowDays` window ending
// at each recorded wake-day, emitting a point only where the minimum-nights gate
// passes. Oldest → newest. Used by the Trends sleep chart to show the trend
// alongside nightly duration.
export function sriTrend(
  sessions: SleepSession[],
  tz: string,
  opts: SleepRegularityOptions = {}
): { date: string; sri: number }[] {
  const { nightsByDay } = buildNights(sessions, tz);
  const anchors = [...nightsByDay.keys()].sort();
  const out: { date: string; sri: number }[] = [];
  for (const asOf of anchors) {
    const r = computeSleepRegularity(sessions, tz, { ...opts, asOf });
    if (r) out.push({ date: asOf, sri: r.sri });
  }
  return out;
}

// A dated situation transition (mirrors lib/trend-annotations.SituationEvent) —
// the subset this module reads to relate an SRI change to a travel window.
export interface SituationChange {
  date: string; // YYYY-MM-DD
  situation: string;
  change: "start" | "stop";
}

// Insight hook (#160): detect a sleep-regularity DROP coinciding with a travel
// situation. Pure and conservative — it fires only on a "clean" signal (a clear
// drop across a travel-start boundary that has enough nights on each side) and
// returns null otherwise, so the caller either shows the note or shows nothing.
//
// `dropPoints` is the minimum SRI drop (window-mean after vs before the travel
// start) worth surfacing; `sideNights` is the minimum trend points required on
// each side of the boundary to trust the comparison.
export function regularityTravelInsight(
  trend: { date: string; sri: number }[],
  situations: SituationChange[],
  opts: { dropPoints?: number; sideNights?: number } = {}
): string | null {
  const dropPoints = opts.dropPoints ?? 10;
  const sideNights = opts.sideNights ?? 5;
  if (trend.length < sideNights * 2) return null;

  // Most recent travel "start" the trend actually straddles.
  const travelStarts = situations
    .filter((s) => s.change === "start" && /travel/i.test(s.situation))
    .map((s) => s.date)
    .sort();
  for (let i = travelStarts.length - 1; i >= 0; i--) {
    const boundary = travelStarts[i];
    const before = trend.filter((p) => p.date < boundary).map((p) => p.sri);
    const after = trend.filter((p) => p.date >= boundary).map((p) => p.sri);
    if (before.length < sideNights || after.length < sideNights) continue;
    const drop = mean(before) - mean(after);
    if (drop >= dropPoints) {
      return `Sleep regularity dropped ${Math.round(drop)} points since your travel on ${boundary}.`;
    }
  }
  return null;
}
