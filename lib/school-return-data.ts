// The DB gather behind the school-return countdown (issue #859 item 2). Turns a
// profile's open illness episode into the two logged clocks the PURE
// computeSchoolReturn (lib/school-return.ts) needs: the last FEVER-RANGE temperature
// reading and the last ANTIPYRETIC administration. ONE gather, three formatters — the
// hero cockpit, the episode page, and the household line all render over the SAME
// SchoolReturnStatus (#221), never a second engine.
//
// Every statement is profile-scoped (the temperature series rides the already-scoped
// AssembledEpisode; the antipyretic query reaches profile_id via its JOIN to
// intake_items, matching assembleIllnessEpisode's own PRN gather).

import { db } from "./db";
import { zonedWallTimeToUtc, parseUtcSql } from "./date";
import { getTimezone, getProfileSetting } from "./settings";
import { formatGivenAtClock } from "./administration-format";
import { parseRxcuiIngredients } from "./rxnorm";
import { isAntipyreticIntakeItem } from "./prn-defaults";
import type { AssembledEpisode } from "./illness-episode-format";
import { computeSchoolReturn, type SchoolReturnStatus } from "./school-return";

// The far-past floor for an episode whose start is unknown (before the change-log),
// mirroring assembleIllnessEpisode.
const OPEN_START_FLOOR = "0001-01-01";

const DEFAULT_THRESHOLD_HOURS = 24;

// The per-profile school-return threshold in hours (the common 24h convention by
// default). Clamped to a sane 1..168h range so a corrupt setting can't produce a
// nonsense countdown.
export function getSchoolReturnThresholdHours(profileId: number): number {
  const raw = getProfileSetting(profileId, "school_return_threshold_hours");
  const n = raw != null ? Number(raw) : NaN;
  if (!Number.isFinite(n)) return DEFAULT_THRESHOLD_HOURS;
  return Math.min(168, Math.max(1, Math.round(n)));
}

// Compute the school-return countdown for an assembled OPEN episode, or null when it
// doesn't apply yet — there has been no fever-range reading in the episode, so there
// is nothing to count down from. `nowMs` is injectable for tests.
export function schoolReturnStatusFor(
  profileId: number,
  episode: AssembledEpisode,
  nowMs: number = Date.now()
): SchoolReturnStatus | null {
  const tz = getTimezone(profileId);

  // Last FEVER-RANGE reading: the newest temperature whose reference-range flag is
  // "high". The episode's temperatures are date-then-time ascending.
  let lastFeverAtMs: number | null = null;
  let lastFeverDegF = 0;
  for (const t of episode.temperatures) {
    if (t.flag !== "high") continue;
    // A day-granular reading with no clock time is anchored at local noon (a neutral
    // mid-day instant) — the countdown is informational and hour-granular.
    const ms = zonedWallTimeToUtc(tz, t.date, t.time ?? "12:00").getTime();
    if (lastFeverAtMs == null || ms >= lastFeverAtMs) {
      lastFeverAtMs = ms;
      lastFeverDegF = t.degF;
    }
  }
  if (lastFeverAtMs == null) return null;

  // Last ANTIPYRETIC administration in the episode window. Mirrors
  // assembleIllnessEpisode's PRN gather (as_needed + status 'taken', profile-scoped by
  // JOIN), then filters to fever reducers via the curated PRN dataset.
  const from = episode.firstDay ?? OPEN_START_FLOOR;
  const to = episode.lastActiveDay ?? episode.asOf;
  const rows = db
    .prepare(
      `SELECT ii.name AS name, ii.rxcui AS rxcui,
              ii.rxcui_ingredients AS rxcui_ingredients,
              l.given_at AS given_at, l.taken_at AS taken_at
         FROM intake_item_logs l
         JOIN intake_items ii ON ii.id = l.item_id
        WHERE ii.profile_id = ? AND l.status = 'taken' AND ii.as_needed = 1
          AND l.date >= ? AND l.date <= ?
        ORDER BY COALESCE(l.given_at, l.taken_at) ASC, l.id ASC`
    )
    .all(profileId, from, to) as {
    name: string;
    rxcui: string | null;
    rxcui_ingredients: string | null;
    given_at: string | null;
    taken_at: string;
  }[];

  let lastAntipyreticAtMs: number | null = null;
  let lastAntipyreticName: string | null = null;
  let lastAntipyreticClockLabel: string | null = null;
  for (const r of rows) {
    if (
      !isAntipyreticIntakeItem({
        name: r.name,
        rxcui: r.rxcui,
        rxcuiIngredients: parseRxcuiIngredients(r.rxcui_ingredients),
      })
    ) {
      continue;
    }
    const stored = r.given_at ?? r.taken_at;
    const d = parseUtcSql(stored);
    if (!d) continue;
    const ms = d.getTime();
    if (lastAntipyreticAtMs == null || ms >= lastAntipyreticAtMs) {
      lastAntipyreticAtMs = ms;
      lastAntipyreticName = r.name;
      lastAntipyreticClockLabel = formatGivenAtClock(tz, stored) || null;
    }
  }

  return computeSchoolReturn({
    lastFeverAtMs,
    lastFeverDegF,
    lastAntipyreticAtMs,
    lastAntipyreticName,
    lastAntipyreticClockLabel,
    nowMs,
    thresholdHours: getSchoolReturnThresholdHours(profileId),
  });
}
