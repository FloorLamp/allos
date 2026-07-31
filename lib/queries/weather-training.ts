// The DB gather for weather-aware training (#1724) and the conditions stamps (#1728).
//
// ONE JOIN, THREE CONSUMERS — the #221 discipline and the explicit ask of both issues.
// `sessionWeather` joins a profile's logged sessions to the cached daily weather of the
// day they happened on, and that single result feeds:
//
//   • the tolerance ENVELOPE (#1724) — what conditions this person actually trains in;
//   • the session STAMP (#1728) — "31°C · sunny" on a journal card;
//   • the Timeline day context (#1728), via the notable-day predicates.
//
// DERIVED AT READ TIME, NEVER WRITTEN ONTO THE ACTIVITY ROW (#1728's explicit
// requirement): one source of truth, no backfill problem, and a cache gap simply
// renders no stamp instead of a stale one.
//
// The weather side is the GLOBAL location-keyed cache, so the join is done in TypeScript
// over two profile-scoped/global reads rather than in SQL — weather_days has no
// profile_id to join on, and keeping the read profile-scoped on the activities side is
// what the scoping guard checks.

import { db } from "../db";
import { getHomeLocation } from "../settings";
import { shiftDateStr } from "../date";
import { getWeatherDays } from "../integrations/weather-cache";
import { isOutdoorActivity } from "../activities-catalog";
import {
  deriveEnvelopes,
  planningLine,
  scanViableDays,
  type SessionWeather,
  type ToleranceEnvelope,
} from "../weather-training";
import { getFrequencyTargetProgress } from "./frequency-targets";
import { getTimezone } from "../settings";
import { getWeatherSeriesThrough } from "./weather-situations";
import type { WeatherDay } from "../weather-situations";

// How much history the envelope derivation reads. A year, so a full cycle of seasons
// can reveal a range — bounded by what the cache actually holds, which is a ceiling not
// a promise (the sync only ever backfills the window it was asked for).
export const ENVELOPE_LOOKBACK_DAYS = 400;

interface ActivityRow {
  id: number;
  date: string;
  title: string;
  type: string;
}

// The profile's logged CARDIO/SPORT sessions in a date window, newest last. Titles are
// the activity names the catalog flags key on.
function sessionRows(
  profileId: number,
  startDate: string,
  endDate: string
): ActivityRow[] {
  return db
    .prepare(
      `SELECT id, date, title, type
         FROM activities
        WHERE profile_id = ?
          AND date >= ? AND date <= ?
          AND type IN ('cardio', 'sport')
        ORDER BY date ASC, id ASC`
    )
    .all(profileId, startDate, endDate) as ActivityRow[];
}

// The shared session-to-weather join over a window. Sessions whose day has no cached
// weather come back with null conditions rather than being dropped — the envelope
// ignores them and the stamp renders nothing, which is the honest treatment in both
// directions. Empty when the profile has no home location (weather features are quietly
// absent, the #570 pattern).
export function sessionWeather(
  profileId: number,
  startDate: string,
  endDate: string
): SessionWeather[] {
  const home = getHomeLocation(profileId);
  const rows = sessionRows(profileId, startDate, endDate);
  if (rows.length === 0) return [];
  const byDate = new Map<string, WeatherDay>();
  if (home) {
    for (const d of getWeatherDays(home.lat, home.lng, startDate, endDate)) {
      byDate.set(d.date, d);
    }
  }
  return rows.map((r) => {
    const day = byDate.get(r.date);
    return {
      date: r.date,
      activity: r.title,
      tempMaxC: day?.tempMaxC ?? null,
      precipitationMm: day?.precipitationMm ?? null,
      weatherCode: day?.weatherCode ?? null,
    };
  });
}

// The tolerance envelopes for every OUTDOOR activity the profile has logged, keyed by
// the folded activity name. Derived from the profile's own history through the pure
// core — nothing is written, and a profile with thin history simply gets the permissive
// fallback constants.
export function getToleranceEnvelopes(
  profileId: number,
  today: string
): Map<string, ToleranceEnvelope> {
  const sessions = sessionWeather(
    profileId,
    shiftDateStr(today, -ENVELOPE_LOOKBACK_DAYS),
    today
  );
  const outdoor = [
    ...new Set(
      sessions.map((s) => s.activity).filter((a) => isOutdoorActivity(a))
    ),
  ];
  return deriveEnvelopes(outdoor, sessions);
}

// Whether the profile can actually DO an indoor candidate — logged history OR owned
// equipment. The engine never invents a machine someone doesn't have, so an alternative
// that fails this check is skipped and the caller falls through with the disclosure
// intact.
export function canDoIndoorActivity(
  profileId: number,
  candidate: string
): boolean {
  const logged = db
    .prepare(
      `SELECT 1 FROM activities
        WHERE profile_id = ? AND title = ? COLLATE NOCASE
        LIMIT 1`
    )
    .get(profileId, candidate);
  if (logged) return true;
  return (
    db
      .prepare(
        `SELECT 1 FROM equipment
          WHERE profile_id = ? AND name = ? COLLATE NOCASE
          LIMIT 1`
      )
      .get(profileId, candidate) != null
  );
}

// ---- Forecast-ahead planning (#1724 part 5) -----------------------------------------
//
// "When this week should the outdoor session happen?" — the SAME tolerance envelope run
// FORWARD over the forecast window. One computation, two surfaces: the digest's
// This-week glance and the calm Upcoming planning item both render `planningLine`'s
// result, so they can never disagree (#221). ZERO NEW SENDS: the digest line rides the
// morning message that already goes out, and the Upcoming item is a page surface.
//
// Gating is deliberately narrow, because a plan line every week is filler rather than
// signal. All of these must hold:
//
//   • a CARDIO weekly target exists and is behind (there is a session still owed);
//   • the profile actually does an OUTDOOR cardio activity (nothing to plan otherwise);
//   • viability is SCARCE — fewer viable days than sessions owed, or a single standout
//     among poor ones (planningWorthSurfacing). A week where every day works needs no
//     plan, and a week where NO day works yields no line either: there is nothing to
//     recommend, and nagging about a week the weather has closed is exactly the
//     escalation the attention doctrine forbids.
//
// Beyond the reliable horizon the scan truncates and the copy hedges ("This week so
// far"), and with no cached forecast at all there is no line — silence over guessing.

// The dedupeKey namespace for the Upcoming planning item, so it rides the shared
// findings-suppression bus like every other calm item. Keyed by ACTIVITY and the week's
// start, so dismissing this week's plan doesn't silence next week's.
export const OUTDOOR_PLAN_PREFIX = "outdoor-plan:";

export function outdoorPlanSignalKey(
  activity: string,
  weekStartDate: string
): string {
  return `${OUTDOOR_PLAN_PREFIX}${activity.trim().toLowerCase()}:${weekStartDate}`;
}

export interface OutdoorPlan {
  activity: string;
  bestDate: string;
  // The ready-to-render line both surfaces show.
  line: string;
  dedupeKey: string;
}

// The weekday label for a date, in the profile's timezone — "Saturday".
function weekdayLabel(date: string, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "long",
  }).format(new Date(`${date}T12:00:00Z`));
}

// The outdoor planning line(s) for this week, or empty. At most one per outdoor
// activity, and in practice at most one overall (the profile's most-practiced outdoor
// cardio) — a planning surface that lists five activities is a chore, not a glance.
export function getOutdoorPlans(
  profileId: number,
  today: string
): OutdoorPlan[] {
  const behindCardio = getFrequencyTargetProgress(profileId).find(
    (t) =>
      t.target.scope_kind === "type" &&
      t.target.scope_value === "cardio" &&
      !t.met
  );
  if (!behindCardio) return [];
  const sessionsOwed = Math.max(1, behindCardio.per_week - behindCardio.count);

  // The remaining on-days of the week INCLUDING today — the days a session could still
  // happen on. Rolling mode reports 0 days left (every day is the last day), and then
  // there is no week to plan across, so the line correctly never appears.
  const daysLeft = behindCardio.daysLeftInWindow;
  if (daysLeft <= 0) return [];
  const candidateDates: string[] = [];
  for (let i = 0; i <= daysLeft; i++)
    candidateDates.push(shiftDateStr(today, i));

  const envelopes = getToleranceEnvelopes(profileId, today);
  if (envelopes.size === 0) return [];

  // The profile's outdoor activities, most-practiced first — the one it would actually
  // plan around.
  const sessions = sessionWeather(
    profileId,
    shiftDateStr(today, -ENVELOPE_LOOKBACK_DAYS),
    today
  );
  const counts = new Map<string, { name: string; n: number }>();
  for (const s of sessions) {
    if (!isOutdoorActivity(s.activity)) continue;
    const key = s.activity.trim().toLowerCase();
    const cur = counts.get(key) ?? { name: s.activity, n: 0 };
    cur.n += 1;
    counts.set(key, cur);
  }
  const lead = [...counts.values()].sort(
    (a, b) => b.n - a.n || a.name.localeCompare(b.name)
  )[0];
  if (!lead) return [];

  const forecast = getWeatherSeriesThrough(
    profileId,
    today,
    candidateDates[candidateDates.length - 1]
  );
  const scan = scanViableDays(
    lead.name,
    today,
    candidateDates,
    forecast,
    envelopes.get(lead.name.trim().toLowerCase()) ?? null
  );
  if (!scan.bestDate) return [];

  const line = planningLine({
    activity: lead.name,
    scan,
    sessionsOwed,
    bestDayLabel: weekdayLabel(scan.bestDate, getTimezone(profileId)),
    progressLabel: `${lead.name.toLowerCase()} ${behindCardio.count}/${behindCardio.per_week}`,
  });
  if (!line) return [];

  return [
    {
      activity: lead.name,
      bestDate: scan.bestDate,
      line,
      dedupeKey: outdoorPlanSignalKey(lead.name, candidateDates[0]),
    },
  ];
}
