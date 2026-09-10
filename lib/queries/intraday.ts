// Gather layer for the Timeline day view's intraday panel (issue #1068).
//
// House shape (#221): this module GATHERS profile-scoped rows and hands them to the
// pure `buildIntradayModel` (lib/intraday.ts); `components/IntradayPanel.tsx` only
// draws the result. No decisions live here.
//
// The event set is NOT re-queried FOR A CALLER THAT LISTS IT: the day view passes its
// feed's already-resolved day events in, so the panel and the list below are literally
// the same rows — the "one visibility predicate" rule holds BY CONSTRUCTION (an event
// dropped by the category filter never reaches this function, so it can't appear as a
// block or a tick).
//
// A CALLER THAT LISTS NOTHING ASKS `getIntradayDayWindows` INSTEAD (#5262). The
// dashboard's "day so far" row draws the chart and no feed, and the owner ruled it
// keeps the session blocks while the feed-sourced ticks leave; that reader below asks
// the block layer's own two questions rather than opening a twenty-domain day gather
// whose row list the row then discards. The mark-names-nothing-unlisted rule holds
// there through a shared COMPOSER rather than a shared row list.
//
// The chart's own data layers have no feed representation at all: the day's per-minute
// HR (one index-supported day scan through the shared one-source-per-day reader) and
// the sleep session windows that overlap the day.

import { db, today } from "../db";
import { now } from "../clock";
import { shiftDateStr, zonedDateParts } from "../date";
import { getTimezone } from "../settings";
import {
  activityWindowEvent,
  buildIntradayModel,
  localStampMinute,
  practiceWindowEvent,
  MINUTES_IN_DAY,
  type ActivityWindowRow,
  type IntradayInput,
  type IntradayModel,
  type IntradaySpanInput,
  type PracticeWindowRow,
  type SleepStage,
} from "../intraday";
import { isDraftActivityRow } from "../activity-draft";
import type { TimelineEvent } from "../timeline-format";
import { getHrMinutes, getSleepSessionsSince } from "./metrics";
import { getProfileZoneModel } from "./zones";

// The per-stage windows Health Connect writes alongside a session's total (each
// stage carries its own start/end instant — see lib/integrations/health-connect).
// A source that reports only per-night stage TOTALS (Oura, Withings) writes the
// session window on every stage row; those degenerate rows are dropped below, so
// the sub-band layer is data-gated on genuinely windowed stages.
const STAGE_METRICS: Record<string, SleepStage> = {
  sleep_deep_min: "deep",
  sleep_rem_min: "rem",
  sleep_light_min: "light",
  sleep_awake_min: "awake",
};

interface StageRow {
  metric: string;
  started_at: string;
  ended_at: string;
}

function stageWindows(profileId: number, date: string): StageRow[] {
  return db
    .prepare(
      `SELECT metric, started_at, ended_at
         FROM metric_samples
        WHERE profile_id = ?
          AND metric IN ('sleep_deep_min','sleep_rem_min','sleep_light_min','sleep_awake_min')
          AND date >= ? AND date <= ?
        ORDER BY started_at`
    )
    .all(profileId, date, shiftDateStr(date, 1)) as StageRow[];
}

// Minutes from `date`'s local midnight to an absolute ISO instant, in `tz`. This is
// the ONLY timezone conversion the panel does (sleep windows and "now" are stored
// as absolute instants; hr_minutes and activity times are already profile-local),
// and it happens here in the gather so the model and the SVG stay zone-free.
function instantMinute(tz: string, date: string, iso: string): number | null {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return null;
  const parts = zonedDateParts(tz, at);
  return localStampMinute(date, `${parts.date}T${parts.hhmm}`);
}

// The day's sleep blocks: every session whose window OVERLAPS the local day, in
// minutes relative to its midnight (negative / >1440 where it extends beyond —
// the pure model clips, so a session is never re-attributed to another day).
function sleepSpans(
  profileId: number,
  date: string,
  tz: string
): IntradaySpanInput[] {
  const sessions = getSleepSessionsSince(profileId, shiftDateStr(date, -1));
  const spans: IntradaySpanInput[] = [];
  for (const s of sessions) {
    const startMinute = instantMinute(tz, date, s.start);
    const endMinute = instantMinute(tz, date, s.end);
    if (startMinute == null || endMinute == null) continue;
    if (endMinute <= 0 || startMinute >= MINUTES_IN_DAY) continue;
    spans.push({
      key: `sleep:${s.date}:${s.start}`,
      startMinute,
      endMinute,
      stages: [],
    });
  }
  if (spans.length === 0) return spans;

  for (const row of stageWindows(profileId, date)) {
    const stage = STAGE_METRICS[row.metric];
    if (!stage) continue;
    const startMinute = instantMinute(tz, date, row.started_at);
    const endMinute = instantMinute(tz, date, row.ended_at);
    if (startMinute == null || endMinute == null) continue;
    if (endMinute <= startMinute) continue;
    // Keep a stage only where it sits INSIDE one of the kept session windows: a
    // source that stamps the whole session window on each stage total would
    // otherwise paint the entire block one stage.
    const host = spans.find(
      (span) =>
        startMinute >= span.startMinute &&
        endMinute <= span.endMinute &&
        endMinute - startMinute < span.endMinute - span.startMinute
    );
    if (!host) continue;
    host.stages!.push({ stage, startMinute, endMinute });
  }
  return spans;
}

// THE DAY'S DRAWN WINDOWS, for a caller that draws the chart and no feed (#5262).
//
// The day view passes its feed's own resolved events (see the header) because it also
// LISTS them. The dashboard's "day so far" row lists nothing: the owner ruled it keeps
// the chart's own layers plus the session blocks, and the marks the history feed
// sources — dose, food and the other ticks — leave the chart. It used to reach them by
// opening `gatherHistoryLog` for the day, which reads about twenty domains to compose a
// row list the dashboard then discards.
//
// SO THIS ASKS THE TWO QUESTIONS THE BLOCK LAYER ACTUALLY HAS. A `clockWindow` is
// carried by exactly two producers, and both compose through the SAME functions the
// feed composes through (lib/intraday.ts) — so a block drawn here is the block the
// record's own day view draws, not a second answer built from the same rows.
//
// BOUNDED BY THE DAY, which is why there is no page size: `date = ?` on both reads, and
// a profile-local day holds as many sessions as a person logged. The draft rule is the
// feed's (#2870): a create-at-start session with nothing in it renders nowhere but its
// own page, so it must not put a mark on this axis either.
export function getIntradayDayWindows(
  profileId: number,
  date: string
): TimelineEvent[] {
  const activities = db
    .prepare(
      `SELECT id, date, type, title, duration_min, distance_km, intensity,
              start_time, end_time, notes, source, components,
              (SELECT COUNT(*) FROM exercise_sets s WHERE s.activity_id = activities.id) AS set_count
         FROM activities
        WHERE profile_id = ? AND date = ?
        ORDER BY id DESC`
    )
    .all(profileId, date) as (ActivityWindowRow & {
    distance_km: number | null;
    notes: string | null;
    source: string | null;
    set_count: number;
  })[];
  const sessions = db
    .prepare(
      `SELECT id, date, practice, start_time, end_time, duration_min, live,
              derived_window, created_at
         FROM practice_logs
        WHERE profile_id = ? AND date = ?
        ORDER BY id`
    )
    .all(profileId, date) as PracticeWindowRow[];
  const at = now();
  return [
    ...activities
      .filter((row) => !isDraftActivityRow(row, row.set_count))
      .map((row) => activityWindowEvent(row)),
    ...sessions.map((row) => practiceWindowEvent(row, at)),
  ];
}

// The panel's model for one profile-local day. ALWAYS returns one — see
// buildIntradayModel's own comment for the empty-day case.
//
// `events` MUST be the feed's own resolved events for this day (see the header).
// `context` carries the day view's two extras no other caller needs: the daylight
// band's sunrise/sunset pair (#4918 ruling 3), and, only while today waits on last
// night's sleep, the expected bed/wake window (ruling 7). Both default to null,
// which is exactly what the dashboard's "day so far" card wants.
export function getIntradayDay(
  profileId: number,
  date: string,
  events: TimelineEvent[],
  context: {
    solarDay?: { sunriseMin: number; sunsetMin: number } | null;
    expectedSleep?: { bedMinutes: number; wakeMinutes: number } | null;
  } = {}
): IntradayModel {
  const tz = getTimezone(profileId);
  const zoneModel = getProfileZoneModel(profileId);
  // Zone 2 = [Z2 floor, Z3 floor) from the SAME zone model the Trends zone section
  // and the weekly recap read — one computation, never a second formula here.
  const zone2 = zoneModel
    ? { low: zoneModel.lowerBounds[1], high: zoneModel.lowerBounds[2] }
    : null;

  const nowMinute =
    date === today(profileId)
      ? localStampMinute(date, `${date}T${zonedDateParts(tz, now()).hhmm}`)
      : null;

  const input: IntradayInput = {
    date,
    events,
    hr: getHrMinutes(profileId, date),
    sleep: sleepSpans(profileId, date, tz),
    zone2,
    nowMinute,
    solarDay: context.solarDay ?? null,
    expectedSleep: context.expectedSleep ?? null,
  };
  return buildIntradayModel(input);
}
