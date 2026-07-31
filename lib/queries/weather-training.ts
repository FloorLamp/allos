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
  type SessionWeather,
  type ToleranceEnvelope,
} from "../weather-training";
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
