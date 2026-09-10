// SLEEP SESSIONS — one of the five submodules behind lib/queries/metrics.ts (issue
// #5171): the per-night stage totals, the session windows the Sleep Regularity Index
// and the Sleep log read (per-night source election), the arrival statistic's
// gather, and the manual-sleep edit gates. Every read is profile-scoped.

import { db } from "../../db";
import { cache } from "../../request-cache";
import { tickCached } from "../../tick-cache";
import {
  pickRowsOneOriginPerSourceDay,
  pickRowsOneSourcePerWindow,
} from "../../metric-sources";
import { getTimezone } from "../../settings";
import {
  hhmmToMinutes,
  isDstTransitionDay,
  parseUtcSql,
  zonedDateParts,
} from "../../date";
import type { ArrivalNight } from "../../notifications/digest-schedule";
import { mainSleepPeriod } from "../../sleep-regularity";
import { resolutionFor } from "./common";

// Per-night MAIN-sleep stage totals (minutes), oldest→newest, pivoted from the four
// sleep_*_min metrics. Stage rows are stored as timestamped observations but carry
// no session id, so attribution is by overlap with the SAME mainSleepPeriod that
// owns the duration/bed/wake summary. A same-wake-day nap therefore stays out of
// the overnight stage chart instead of making its stack out-sum the duration point.
//
// Source/origin selection follows the sleep_min session read first, then stage rows
// must match that elected stream. This preserves issue #14's one-source-per-night
// contract while avoiding an independent stage-only election that could choose a
// different wearable from the session whose duration is shown.
//
// `limitDays` is a READ bound, not a post-slice (#2520): it is the SQL LIMIT on the
// stage-day scan, and the cutoff it yields bounds every other statement here. So a
// caller asking for 14 nights reads 14 nights' rows — Health Connect stores one row
// per stage per night, so the difference between the caller's window and this
// function's default is thousands of rows on a daily wearable user. The returned
// series can be SHORTER than `limitDays`: a stage day whose elected main session is
// missing contributes no row, and that is the honest answer for "the last N days
// that have stage data" rather than a silent look-back past the window.
export function getSleepStageDailyTotals(
  profileId: number,
  limitDays = 180
): { date: string; deep: number; rem: number; light: number; awake: number }[] {
  const recentDates = db
    .prepare(
      `SELECT date FROM metric_samples
        WHERE profile_id = ?
          AND metric IN ('sleep_deep_min','sleep_rem_min','sleep_light_min','sleep_awake_min')
        GROUP BY date ORDER BY date DESC LIMIT ?`
    )
    .all(profileId, limitDays) as { date: string }[];
  if (recentDates.length === 0) return [];
  const cutoff = recentDates[recentDates.length - 1].date;
  const rows = db
    .prepare(
      `SELECT date, metric, started_at AS start, ended_at AS end,
              source, origin, value
         FROM metric_samples
        WHERE profile_id = ? AND date >= ?
          AND metric IN ('sleep_deep_min','sleep_rem_min','sleep_light_min','sleep_awake_min')`
    )
    .all(profileId, cutoff) as {
    date: string;
    metric: string;
    start: string;
    end: string;
    source: string | null;
    origin: string | null;
    value: number;
  }[];

  // Elect the sleep_min source/origin with the SAME resolution the additive
  // duration chart uses. The SRI session read has a different, stream-wide fallback
  // (the newest source), so routing this chart through it could make the duration
  // point Health Connect while its stages came from Oura.
  //
  // Per overlapping WINDOW, not per day (#2552): a manual nap on the same wake-day
  // used to win the whole day, leaving `mainSleepPeriod` to elect that nap as the
  // night — and no stage row matches a manual session's source, so the night's
  // entire stage stack disappeared from the chart.
  const rawSessions = db
    .prepare(
      `SELECT date, started_at AS start, ended_at AS end, source, origin, value
         FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min' AND date >= ?
          AND julianday(ended_at) > julianday(started_at)`
    )
    .all(profileId, cutoff) as SelectedSleepSessionRow[];
  const sessions = pickRowsOneSourcePerWindow(
    pickRowsOneOriginPerSourceDay(
      rawSessions,
      (row) => row.date,
      (row) => row.source,
      (row) => row.origin,
      (row) => row.value
    ),
    resolutionFor(profileId, "sleep_min"),
    (row) => row.start,
    (row) => row.end,
    (row) => row.source,
    (row) => row.value
  );
  const sessionsByDay = new Map<string, SelectedSleepSessionRow[]>();
  for (const session of sessions) {
    const day = sessionsByDay.get(session.date);
    if (day) day.push(session);
    else sessionsByDay.set(session.date, [session]);
  }
  // Bucket the stage rows by date ONCE. The attribution below is per day, and
  // rescanning the whole array inside that loop made the cost days × rows — a few
  // thousand stage rows over a half-year window is ~10^6 iterations to answer about
  // a handful of nights (#2520). The attribution itself is unchanged; only its
  // access pattern was quadratic.
  const rowsByDay = new Map<string, typeof rows>();
  for (const row of rows) {
    const day = rowsByDay.get(row.date);
    if (day) day.push(row);
    else rowsByDay.set(row.date, [row]);
  }

  const out: {
    date: string;
    deep: number;
    rem: number;
    light: number;
    awake: number;
  }[] = [];
  for (const [date, daySessions] of sessionsByDay) {
    const period = mainSleepPeriod(daySessions);
    if (!period) continue;
    const windows = period.members.map((member) => ({
      start: new Date(member.start).getTime(),
      end: new Date(member.end).getTime(),
    }));
    const totals = { deep: 0, rem: 0, light: 0, awake: 0 };
    let found = false;
    for (const row of rowsByDay.get(date) ?? []) {
      if (row.source !== period.main.source) continue;
      if (row.origin !== period.main.origin) continue;
      // Fitbit Takeout aggregate-stage rows append `#deep` / `#rem` / ... to
      // the session start as part of their natural storage key. The prefix is
      // still the real session boundary used for overlap attribution.
      const keySuffix = row.start.indexOf("#");
      const stageStart =
        keySuffix < 0 ? row.start : row.start.slice(0, keySuffix);
      const start = new Date(stageStart).getTime();
      const end = new Date(row.end).getTime();
      if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
        continue;
      if (!windows.some((window) => end > window.start && start < window.end))
        continue;
      const key = row.metric.slice("sleep_".length, -"_min".length) as
        "deep" | "rem" | "light" | "awake";
      totals[key] += row.value;
      found = true;
    }
    if (!found) continue;
    // Round ONCE, after the chosen main session's rows have been summed. Health
    // Connect stores sub-minute stage observations, so per-row rounding would
    // accumulate error across a night full of 30-second micro-arousals.
    out.push({
      date,
      deep: Math.round(totals.deep),
      rem: Math.round(totals.rem),
      light: Math.round(totals.light),
      awake: Math.round(totals.awake),
    });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : 1)).slice(-limitDays);
}

// Raw per-night sleep sessions (metric 'sleep_min') as absolute time windows,
// newest→oldest, capped at `limit` rows — the input to the Sleep Regularity Index
// (#160), which needs each session's start/end INSTANTS (not the derived per-day
// totals) to reconstruct the sleep/wake timeline in the profile timezone.
//
// SOURCE HANDLING IS PER NIGHT (#1851), and this memo used to say the opposite.
//
// It read: the SRI math assumes ONE session stream, so when several sources have
// sessions the profile's primary source wins and everything else is filtered out,
// falling back to the most-recently-synced stream (#14, reprobed by #2603). That
// rule answered the wrong question the moment a person could type a night the
// wearable missed. A stream-wide election has only two moves — keep the device and
// throw the typed nights away, or keep the typed nights and throw a wearable's whole
// history away — and it made the second one: ONE hand-typed window elected `manual`
// for the profile and returned 1 session where 30 Oura overnights had been, taking
// the SRI to null. The ring's own sync for that same night did not win it back,
// because a person types when they got up while a ring records sleep offset.
//
// So the bucket is the NIGHT. Rows are resolved by `pickRowsOneSourcePerWindow` —
// the same election, over the same profile resolution, that `getDailySleepSessionsSince`
// has used for date-keyed display history since #2552 — and the two reads now
// differ only in their bounding, which is the difference that was ever real.
//
// WHAT THAT COSTS AND WHY IT IS AFFORDABLE. The stream rule existed to stop two
// sources reporting the SAME nights from interleaving duplicate windows into one
// timeline; that hazard is real and it is exactly what an overlap cluster catches,
// because a duplicate account of one night covers the same clock time. What the day
// grain could not tell apart, and the window grain can, is a duplicate from a second
// EVENT: a wearable's overnight plus a hand-logged nap are two things that happened.
// A typed night the device never recorded overlaps nothing, so it fills its own gap
// and displaces nobody — which is the whole of what this change buys.
//
// IT ALSO RETIRES THE #2603 PROBE rather than working around it. That probe existed
// because a nap synced by a phone was the newest session most afternoons and elected
// the phone for the entire profile, blanking a ring's history. Under a per-night
// election the nap is its own cluster: it never reaches the ring's nights, so there
// is nothing for a recency heuristic to get wrong. Recency as a profile-wide rule is
// gone with it — a new wearable takes over the nights it actually records, on the
// nights it records them, which is what "taking over" meant.
//
// WHAT WOULD SHOW IT WORKING: a profile with 30 device overnights and one typed
// night the device missed returns 31 sessions, the device's 30 unchanged. WHAT WOULD
// SHOW IT WRONG: two sources reporting the SAME night both surviving into the list,
// which is the interleave #14 forbids and the reason the resolution is per window
// rather than per row. THE DECEPTIVE SUCCESS is unchanged from #2603 — "sessions
// returned per read went up" also goes up when duplicates interleave — so the honest
// measure is still each source's own night count.
//
// A STRICT choice (#1642) still applies unconditionally, now per night: a night the
// chosen selector did not cover keeps no rows at all, rather than being answered by
// whoever did record it. `pickRowsOneSourcePerWindow` is where that holds.
export interface SleepSessionRow {
  date: string;
  start: string;
  end: string;
  value: number;
  source: string | null;
}

interface SelectedSleepSessionRow extends SleepSessionRow {
  origin: string | null;
}

// A sleep sample is an OVERNIGHT rather than a nap at/above this duration. The
// provenance ledger carries no session label, so the sample is bounded by duration
// instead: a three-hour window is short for a night and long for a nap.
//
// TWO askers, one number, because it is one question. The arrival statistic (#2214)
// asks it to keep a nap's sync latency out of "when does last night normally land?";
// the stream election above asks it to keep a nap from electing a whole source
// (#2603). Migration 166 froze its own COPY of this floor under the constant's former
// name — a shipped migration must keep converting as it did on the day it ran, so
// retuning this number deliberately does not reach back into it.
const SLEEP_OVERNIGHT_MIN_MINUTES = 180;

function readSleepSessions(
  profileId: number,
  opts: { limit?: number; since?: string; through?: string }
): SleepSessionRow[] {
  const validWindow = " AND julianday(ended_at) > julianday(started_at)";
  let cutoff = opts.since;
  if (cutoff == null) {
    // Bound the read by recent wake dates before origin and source selection.
    // Applying LIMIT to raw rows would let duplicate origins consume the cap and
    // drop valid older nights; the final slice happens only after one origin and
    // one source remain per night.
    const recentDates = db
      .prepare(
        `SELECT date FROM metric_samples
          WHERE profile_id = ? AND metric = 'sleep_min'
            ${validWindow}
          GROUP BY date ORDER BY date DESC LIMIT ?`
      )
      .all(profileId, opts.limit ?? 800) as { date: string }[];
    if (recentDates.length === 0) return [];
    cutoff = recentDates[recentDates.length - 1].date;
  }

  const rowParams: (number | string)[] = [profileId, cutoff];
  const throughFilter = opts.through ? " AND date <= ?" : "";
  if (opts.through) rowParams.push(opts.through);
  const rows = db
    .prepare(
      `SELECT date, started_at AS start, ended_at AS end, source, origin, value
       FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min'
          ${validWindow}
          AND date >= ?
          ${throughFilter}
        ORDER BY ended_at DESC`
    )
    .all(...rowParams) as {
    date: string;
    start: string;
    end: string;
    source: string | null;
    origin: string | null;
    value: number;
  }[];
  const picked = pickRowsOneSourcePerWindow(
    pickRowsOneOriginPerSourceDay(
      rows,
      (r) => r.date,
      (r) => r.source,
      (r) => r.origin,
      (r) => r.value
    ),
    resolutionFor(profileId, "sleep_min"),
    (r) => r.start,
    (r) => r.end,
    (r) => r.source,
    (r) => r.value
  );
  const limited =
    opts.limit == null ? picked : picked.slice(0, Math.max(0, opts.limit));
  return limited.map(({ date, start, end, value, source }) => ({
    date,
    start,
    end,
    value,
    source,
  }));
}

// The profile's recent session windows, row-capped. THE sleep-session read: the SRI,
// the consistency strip, the typical wake time, the digest's Sleep section and the
// digest's own send decision all start here.
//
// MEMOIZED ON BOTH LIFETIMES (#2283). This is a two-statement read — the
// recent-wake-day window, then every session row in it — followed by per-source/day
// origin selection and per-night source resolution, both in JS. The DISTINCT source
// scan that used to open it went with the profile-wide election (#1851), and the memo
// is worth no less without it: the two statements left are the expensive pair, and ONE
// digest tick still asks for them TWICE for the same profile:
// `digestSleepPendingTrace` asks "has last night landed?" to reach the decision, and
// `gatherDigestSleep` asks again to build the section that decision sends.
// `cache()` is identity in a tick (lib/request-cache.ts says so deliberately), so the
// collapse that matters here is `tickCached`; the `cache()` beside it collapses
// the Sleep page's own repeated reads (the SRI, the consistency strip and the wake-time
// derivation each start from this list) into one per request.
//
// Nothing inside a tick writes these rows AFTER the first read: `syncIntegrations` is
// the first statement of `tickProfile`, so the pull pass has finished writing
// `metric_samples` before anything in the scope reads them, and every other writer of
// that table (lib/reading-writes.ts, lib/offline/writes.ts, lib/ttc-store.ts,
// lib/bulk-correction-db.ts) is reached from a Server Action or a route handler — the
// web request or the sidecar's separate `poll` mode, never from inside the scope. The
// scope closes with the profile — see lib/tick-cache.ts for the rule this depends on.
//
// The returned array is treated as read-only by every caller (the pure sleep cores
// copy before sorting), which is what makes one array safe to hand to all of them.
export const getSleepSessions = cache(
  tickCached(
    "getSleepSessions",
    (profileId: number, limit = 800) => `${profileId}:${limit}`,
    getSleepSessionsUncached
  )
);

function getSleepSessionsUncached(
  profileId: number,
  limit = 800
): SleepSessionRow[] {
  return readSleepSessions(profileId, { limit });
}

// All valid session windows on or after a calendar cutoff. Unlike the row-capped
// SRI reader, this cannot lose older wake-days when one day contains several naps.
export function getSleepSessionsSince(
  profileId: number,
  since: string
): SleepSessionRow[] {
  return readSleepSessions(profileId, { since });
}

// Valid sleep windows on or after a calendar cutoff, for the Sleep log's date-keyed
// display history.
//
// IT IS NOW THE SAME READ as getSleepSessionsSince, and the duplicate SQL and
// election this carried have gone (#1851). It existed because the two answered
// different questions: display history resolved PER OVERLAPPING WINDOW (#2552) so a
// hand-logged nap could not take a wearable's overnight down with it, while the SRI
// reader elected one stream for the whole profile. The owner's per-night ruling made
// that second rule the first one, so keeping two spellings of one election is how
// they drift apart again. The name stays because the Sleep log's call site means
// "the days", not "the stream".
export function getDailySleepSessionsSince(
  profileId: number,
  since: string
): SleepSessionRow[] {
  return readSleepSessions(profileId, { since });
}

// Every valid sleep session whose stored wake-day is inside the selected calendar
// range. This is intentionally date-bounded rather than row-capped: a historical
// Trends window must not disappear merely because newer nights consumed the
// regular SRI reader's 800-row safety cap.
export function getSleepSessionsInRange(
  profileId: number,
  from?: string,
  to?: string
): SleepSessionRow[] {
  return readSleepSessions(profileId, {
    since: from ?? "0000-01-01",
    through: to,
  });
}

// WHEN each recent night's row actually landed — the GATHER behind the arrival
// statistic (#2214). The decision itself is `arrivalStatistics`
// (lib/notifications/digest-schedule.ts); this side reads rows and converts
// timestamps, and takes no percentile of its own.
//
// THREE CONVENTIONS CROSSED IN ONE READ, all through shared helpers (#2205):
//   • `ms.ended_at` is a canonical instant carrying `Z`;
//   • `r.created_at` was moved onto the same canonical instant by migration 163,
//     so `MIN(...)` over it is a chronological minimum rather than a lexical
//     accident, and both sides parse through `parseUtcSql`;
//   • the ARRIVAL MINUTE is profile-local, resolved through `zonedDateParts` — the
//     one place an absolute instant becomes a local day and wall clock (#94).
// No offset is hand-rolled here, and no instant is hand-built.
//
// `MIN(created_at)` per sample is the FIRST time the row appeared: a later re-sync
// updates the same row and must not be mistaken for a slower arrival.
//
// Rows with no provenance are silently absent, which is the correct answer — a
// manually logged night has no arrival to measure, and the statistic's sample gate
// turns "too few measurable nights" into a stated no-answer rather than a guess.
//
// MEMOIZED ON BOTH LIFETIMES (#2249). This is a 30-night join over
// `metric_samples × integration_sync_rows` with a `MIN(created_at)` group-by, and a
// DYNAMIC digest tick asks it TWICE for the same profile: once through
// `digestDeadline` for the deadline, and again in `logDigestTick`, which quotes the
// same statistic in its evidence line (#2209/#2220) — same gather, same tick, same
// profile, on every re-check tick. `cache()` is identity in
// a tick (lib/request-cache.ts says so deliberately), so the collapse that matters
// here is `tickCached`; the `cache()` beside it is what collapses the Settings page's
// own two reads (the Dynamic caption's `arrivalStats` and the #2217 suggestion's
// resolver) into one per request.
//
// Nothing inside a tick writes these rows AFTER the first read: `syncIntegrations` is
// the first statement of `tickProfile`, so the pull pass has finished writing
// `metric_samples` and `integration_sync_rows` before anything in the scope reads
// them, and no later tick step writes either table. The scope closes with the profile
// — see lib/tick-cache.ts for the rule this depends on.
export const getSleepArrivals = cache(
  tickCached(
    "getSleepArrivals",
    (profileId: number, limitNights = 30) => `${profileId}:${limitNights}`,
    getSleepArrivalsUncached
  )
);

function getSleepArrivalsUncached(
  profileId: number,
  limitNights = 30
): ArrivalNight[] {
  const tz = getTimezone(profileId);
  const rows = db
    .prepare(
      `SELECT ms.ended_at AS endTime, MIN(r.created_at) AS arrivedAt
         FROM metric_samples ms
         JOIN integration_sync_rows r
           ON r.target_table = 'metric_samples' AND r.target_id = ms.id
        WHERE ms.profile_id = ?
          AND ms.metric = 'sleep_min'
          AND ms.started_at IS NOT NULL
          AND ms.ended_at IS NOT NULL
          AND julianday(ms.ended_at) > julianday(ms.started_at)
          AND ms.value >= ?
        GROUP BY ms.id
        ORDER BY ms.date DESC
        LIMIT ?`
    )
    .all(profileId, SLEEP_OVERNIGHT_MIN_MINUTES, limitNights) as {
    endTime: string | null;
    arrivedAt: string | null;
  }[];
  return rows.flatMap((r) => {
    const ended = parseUtcSql(r.endTime);
    const arrived = parseUtcSql(r.arrivedAt);
    if (!ended || !arrived) return [];
    const { date, hhmm } = zonedDateParts(tz, arrived);
    return [
      {
        date,
        arrivalMinute: hhmmToMinutes(hhmm),
        lagMin: Math.round((arrived.getTime() - ended.getTime()) / 60000),
        dstTransition: isDstTransitionDay(tz, date),
      },
    ];
  });
}

// The profile's OWN manual sleep entries — the rows the Sleep log's inline editor
// may update. Imported and synced sessions remain read-only.
//
// PROVENANCE IS THE TEST, not the natural key (#1851). This used to additionally
// require the row's exact midnight start/end, which was the same question only while
// every windowed row was somebody else's: the moment the measurements form could
// state a bed/wake pair, a night the person typed themselves answered "Synced sleep
// entries cannot be edited here." A window is not what makes a row untouchable.
interface ManualSleepEditabilityRow {
  date: string;
  /** The manual sample's own row id — what a per-reading delete has to name (#2556). */
  id: number | null;
  value: number | null;
  editable: number;
}

function getManualSleepEditability(
  profileId: number,
  since: string,
  through: string
): ManualSleepEditabilityRow[] {
  return db
    .prepare(
      `SELECT date,
              MAX(CASE WHEN source = 'manual' AND origin IS NULL
                       THEN value END) AS value,
              -- Safe as a MAX: the editable flag below only holds when the day
              -- has EXACTLY ONE sample and that one is the profile's own manual
              -- row, so there is never a second id for this to pick between.
              MAX(CASE WHEN source = 'manual' AND origin IS NULL
                       THEN id END) AS id,
              CASE WHEN COUNT(*) = 1
                         AND SUM(CASE WHEN source = 'manual' AND origin IS NULL
                                      THEN 1 ELSE 0 END) = 1
                   THEN 1 ELSE 0 END AS editable
         FROM metric_samples
        WHERE profile_id = ? AND metric = 'sleep_min'
          AND date >= ? AND date <= ?
        GROUP BY date ORDER BY date`
    )
    .all(profileId, since, through) as ManualSleepEditabilityRow[];
}

export function getEditableManualSleepDurations(
  profileId: number,
  since: string,
  through = "9999-12-31"
): { id: number | null; date: string; value: number }[] {
  return getManualSleepEditability(profileId, since, through).flatMap((row) =>
    row.editable === 1 && row.value != null
      ? [{ id: row.id, date: row.date, value: row.value }]
      : []
  );
}

// Re-check the Sleep log's edit invariant at the write boundary. A missing day
// may receive a duration-only manual row; an existing day is editable only when
// its sole sleep sample is the profile's OWN manual row (#1851 widened that from
// the exact midnight key — see above). `upsertManualSleep` keeps an existing window
// when a duration-only correction lands on it, so editing the hours here does not
// discard the clocks either, unless the new hours no longer fit inside them.
// Reading this inside the caller's IMMEDIATE transaction closes the render→save
// race with an integration sync and prevents a crafted action request from
// layering manual sleep over imported or windowed data.
export function canEditManualSleepOnDate(
  profileId: number,
  date: string
): boolean {
  const row = getManualSleepEditability(profileId, date, date)[0];
  return row == null || row.editable === 1;
}
