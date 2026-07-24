// Gather layer for the Timeline day view's intraday panel (issue #1068).
//
// House shape (#221): this module GATHERS profile-scoped rows and hands them to the
// pure `buildIntradayModel` (lib/intraday.ts); `components/IntradayPanel.tsx` only
// draws the result. No decisions live here.
//
// The event set is NOT re-queried: the caller passes the feed's already-resolved
// day events in, so the panel and the list below are literally the same rows — the
// "one visibility predicate" rule holds BY CONSTRUCTION (an age-restricted training
// event, or one dropped by the category filter, never reaches this function, so it
// can't appear as a block or a tick). The only additional reads are the chart's own
// data layers, which have no feed representation at all: the day's per-minute HR
// (one index-supported day scan through the shared one-source-per-day reader) and
// the sleep session windows that overlap the day.

import { db, today } from "../db";
import { now } from "../clock";
import { shiftDateStr, zonedDateParts } from "../date";
import { getTimezone } from "../settings";
import {
  buildIntradayModel,
  localStampMinute,
  MINUTES_IN_DAY,
  type IntradayInput,
  type IntradayModel,
  type IntradaySpanInput,
  type SleepStage,
} from "../intraday";
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
  start_time: string;
  end_time: string;
}

function stageWindows(profileId: number, date: string): StageRow[] {
  return db
    .prepare(
      `SELECT metric, start_time, end_time
         FROM metric_samples
        WHERE profile_id = ?
          AND metric IN ('sleep_deep_min','sleep_rem_min','sleep_light_min','sleep_awake_min')
          AND date >= ? AND date <= ?
        ORDER BY start_time`
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
    const startMinute = instantMinute(tz, date, row.start_time);
    const endMinute = instantMinute(tz, date, row.end_time);
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

// The panel's model for one profile-local day, or null when nothing on the day is
// intraday (no HR, no sleep, no windowed workout, no clock-timed event) — the
// caller then renders no frame at all.
//
// `events` MUST be the feed's own resolved events for this day (see the header).
export function getIntradayDay(
  profileId: number,
  date: string,
  events: TimelineEvent[]
): IntradayModel | null {
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
  };
  return buildIntradayModel(input);
}
