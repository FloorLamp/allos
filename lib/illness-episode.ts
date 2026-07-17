// The ONE illness-episode assembly (issue #801). Given a profile and a DERIVED
// illness episode (lib/symptom-episode.ts — a [start, end) situation window, never
// re-derived here), this gathers every ingredient of the illness story — per-symptom
// severity series, the temperature/fever curve (#800), PRN administrations with their
// snapshotted amounts (#797), and the conditions bridged from the range — into ONE
// `AssembledEpisode`. EVERY surface (timeline card, dashboard illness hero, Household
// page "sick day" chip, share/print page) formats over this result; there is
// no second episode engine (#221). The pure shapes + formatters live in
// lib/illness-episode-format.ts; this module owns only the DB gather.
//
// Range → SQL window: `start` is the inclusive first active day; `end` is EXCLUSIVE
// (the first inactive day), so the last active day is `end`-minus-one, and an ongoing
// episode (`end` null) runs through `asOf` (today, profile-local). A null `start`
// (active before the capped change-log) floors the lower bound so the whole known run
// is captured. Every statement is profile-scoped (direct `profile_id` or a JOIN to
// intake_items) per the scoping rule.

import { db } from "./db";
import { today } from "./db";
import { shiftDateStr, daysBetweenDateStr } from "./date";
import { getTimezone } from "./settings";
import { getSymptomDaysInRange } from "./queries/symptoms";
import { getConditions } from "./queries/clinical";
import type { Condition } from "./types";
import { symptomLabel } from "./symptoms";
import { VITAL_CANONICAL } from "./vitals-input";
import { formatGivenAtClock } from "./administration-format";
import {
  getIllnessSituations,
  getSituationEvents,
} from "./settings/profile-attrs";
import { episodeContainingDate, type IllnessEpisode } from "./symptom-episode";
import {
  episodeRowToDerived,
  getEpisodeRow,
  getEpisodeRowForDate,
  listEpisodeRows,
} from "./illness-episode-store";
import type {
  AssembledEpisode,
  SymptomSeries,
  TemperaturePoint,
  EpisodeMedication,
  EpisodeCondition,
  AdministrationPoint,
} from "./illness-episode-format";
import {
  isOpenEpisode,
  episodeConditionExternalId,
} from "./illness-episode-format";

const TEMP_CANONICAL = VITAL_CANONICAL.temperature.canonical;

// The far-past floor used when an episode's start is unknown (before the change-log).
const OPEN_START_FLOOR = "0001-01-01";

// Assemble the full illness story for one derived episode. `conditions` may be passed
// pre-fetched so a caller assembling MANY episodes for one profile (the episodes-index
// summary, #886) hoists the profile-invariant getConditions() out of its loop rather
// than re-running its full-table window subquery once per episode; when omitted it's
// fetched here (every single-episode caller is unchanged).
export function assembleIllnessEpisode(
  profileId: number,
  episode: IllnessEpisode,
  presetConditions?: Condition[]
): AssembledEpisode {
  const asOf = today(profileId);
  const tz = getTimezone(profileId);
  const ongoing = episode.end == null;
  // Inclusive query window. `to` is the last active day: end-minus-one for a closed
  // episode, else today for an ongoing one.
  const to = episode.end ? shiftDateStr(episode.end, -1) : asOf;
  const from = episode.start ?? OPEN_START_FLOOR;

  // ── Symptoms: per-symptom severity series (worst-first) ─────────────────────
  const dayRollups = getSymptomDaysInRange(profileId, from, to);
  const bySymptom = new Map<string, SymptomSeries>();
  // getSymptomDaysInRange is newest-day-first; build each series oldest-first.
  for (const day of [...dayRollups].reverse()) {
    for (const s of day.symptoms) {
      let series = bySymptom.get(s.symptom);
      if (!series) {
        series = {
          symptom: s.symptom,
          label: symptomLabel(s.symptom),
          points: [],
          maxSeverity: 0,
        };
        bySymptom.set(s.symptom, series);
      }
      series.points.push({
        date: day.date,
        severity: s.severity,
        note: s.note,
      });
      series.maxSeverity = Math.max(series.maxSeverity, s.severity);
    }
  }
  const symptoms = [...bySymptom.values()].sort(
    (a, b) =>
      b.maxSeverity - a.maxSeverity ||
      a.label.localeCompare(b.label, undefined, { sensitivity: "base" })
  );

  // ── Temperature / fever curve (#800) ────────────────────────────────────────
  const tempRows = db
    .prepare(
      `SELECT date, notes, value_num, flag FROM medical_records
        WHERE profile_id = ? AND canonical_name = ?
          AND date >= ? AND date <= ? AND value_num IS NOT NULL
        ORDER BY date ASC, COALESCE(notes, '') ASC`
    )
    .all(profileId, TEMP_CANONICAL, from, to) as {
    date: string;
    notes: string | null;
    value_num: number;
    flag: string | null;
  }[];
  const temperatures: TemperaturePoint[] = tempRows.map((r) => ({
    date: r.date,
    time: /^\d{2}:\d{2}$/.test(r.notes ?? "") ? r.notes : null,
    degF: r.value_num,
    flag: r.flag,
  }));
  const maxTempF = temperatures.reduce<number | null>(
    (m, t) => (m == null || t.degF > m ? t.degF : m),
    null
  );
  const latestTemp =
    temperatures.length > 0 ? temperatures[temperatures.length - 1] : null;

  // ── PRN administrations with amounts (#797) ─────────────────────────────────
  // Only AS-NEEDED (PRN) meds: the illness story is what was taken FOR the illness
  // (ibuprofen, a decongestant), not the profile's standing daily regimen — a
  // scheduled supplement confirmed every day would drown out the signal.
  const admRows = db
    .prepare(
      `SELECT l.item_id AS item_id, ii.name AS name, l.date AS date,
              l.given_at AS given_at, l.taken_at AS taken_at, l.amount AS amount
         FROM intake_item_logs l
         JOIN intake_items ii ON ii.id = l.item_id
        WHERE ii.profile_id = ? AND l.status = 'taken' AND ii.as_needed = 1
          AND l.date >= ? AND l.date <= ?
        ORDER BY l.date ASC, COALESCE(l.given_at, l.taken_at) ASC, l.id ASC`
    )
    .all(profileId, from, to) as {
    item_id: number;
    name: string;
    date: string;
    given_at: string | null;
    taken_at: string;
    amount: string | null;
  }[];
  const byMed = new Map<number, EpisodeMedication>();
  for (const r of admRows) {
    let med = byMed.get(r.item_id);
    if (!med) {
      med = { itemId: r.item_id, name: r.name, count: 0, administrations: [] };
      byMed.set(r.item_id, med);
    }
    const point: AdministrationPoint = {
      date: r.date,
      time: formatGivenAtClock(tz, r.given_at ?? r.taken_at) || null,
      amount: r.amount,
    };
    med.administrations.push(point);
    med.count += 1;
  }
  const medications = [...byMed.values()].sort(
    (a, b) => b.count - a.count || a.name.localeCompare(b.name)
  );
  const totalAdministrations = admRows.length;

  // ── Conditions bridged from / overlapping the window ────────────────────────
  const promotedExternal = episodeConditionExternalId(
    episode.situation,
    episode.start
  );
  const conditions: EpisodeCondition[] = (
    presetConditions ?? getConditions(profileId)
  )
    .filter((c) => {
      const fromEp = c.external_id === promotedExternal;
      const onsetInRange =
        c.onset_date != null && c.onset_date >= from && c.onset_date <= to;
      return fromEp || onsetInRange;
    })
    .map((c) => ({
      id: c.id,
      name: c.name,
      status: c.status,
      onset_date: c.onset_date,
      resolved_date: c.resolved_date,
      fromEpisode: c.external_id === promotedExternal,
    }));

  // ── Notes (symptom notes + timed temperature notes), oldest first ───────────
  const notes: { date: string; text: string }[] = [];
  for (const series of symptoms) {
    for (const p of series.points) {
      if (p.note)
        notes.push({ date: p.date, text: `${series.label}: ${p.note}` });
    }
  }
  notes.sort((a, b) => a.date.localeCompare(b.date));

  // ── Concrete window bookkeeping ─────────────────────────────────────────────
  const dataDays = [
    ...symptoms.flatMap((s) => s.points.map((p) => p.date)),
    ...temperatures.map((t) => t.date),
    ...medications.flatMap((m) => m.administrations.map((a) => a.date)),
  ].sort();
  const firstDay = episode.start ?? (dataDays.length > 0 ? dataDays[0] : null);
  const lastActiveDay = to;
  const dayCount =
    firstDay && lastActiveDay
      ? (daysBetweenDateStr(firstDay, lastActiveDay) ?? 0) + 1
      : null;

  return {
    id: episode.id ?? null,
    situation: episode.situation,
    start: episode.start,
    end: episode.end,
    ongoing,
    firstDay,
    lastActiveDay,
    asOf,
    dayCount,
    symptoms,
    distinctSymptomCount: symptoms.length,
    temperatures,
    maxTempF,
    latestTemp,
    medications,
    totalAdministrations,
    conditions,
    notes,
  };
}

// The illness episode that CONTAINS `date` for a profile, or null. Reads the stored
// episode rows (#856): the tightest (most-recently-started) row whose [start, end)
// covers `date`. The row's id rides along so callers can link to the [id] route.
export function episodeForProfileDate(
  profileId: number,
  date: string
): IllnessEpisode | null {
  const row = getEpisodeRowForDate(profileId, date);
  return row ? episodeRowToDerived(row) : null;
}

// One stored episode by id (the /medical/episodes/[id] route + the id-anchored share
// resolver), or null. The assembled model's range comes straight from the row.
export function episodeForProfileId(
  profileId: number,
  id: number
): IllnessEpisode | null {
  const row = getEpisodeRow(profileId, id);
  return row ? episodeRowToDerived(row) : null;
}

// The episode of a NAMED situation containing `date` for a profile, or null — the
// share/detail resolver, which pins the situation the link/route was minted for.
export function episodeForProfileSituationDate(
  profileId: number,
  situation: string,
  date: string
): IllnessEpisode | null {
  const flagged = getIllnessSituations(profileId).find(
    (s) => s.name.trim().toLowerCase() === situation.trim().toLowerCase()
  );
  if (!flagged) return null;
  return episodeContainingDate(
    date,
    flagged.name,
    getSituationEvents(profileId),
    flagged.active
  );
}

// The profile's CURRENT open illness episode (containing today), assembled — or null
// when not currently sick. The illness hero's cross-profile accordion + the Household
// page "sick day" chip key on this.
export function currentEpisodeForProfile(
  profileId: number
): AssembledEpisode | null {
  const ep = episodeForProfileDate(profileId, today(profileId));
  if (!ep) return null;
  const assembled = assembleIllnessEpisode(profileId, ep);
  return isOpenEpisode(assembled) ? assembled : null;
}

// The profile's open episode ROW (containing today), assembled — WITHOUT the
// has-a-signal gate, so the illness hero's ACTIVE cockpit (issue #858) appears the
// instant the illness situation is activated, before the first symptom/temp is logged
// (the #843 door-A flow, which needs the logging surface visible immediately). An open
// row exists whenever the situation is active (syncOpenIllnessEpisode opens it), so this
// keys the acting profile's full cockpit; the cross-profile accordion still uses the
// signal-gated currentEpisodeForProfile to keep a not-yet-symptomatic member off the
// household list. Null when no open episode row covers today.
export function openEpisodeForProfile(
  profileId: number
): AssembledEpisode | null {
  const ep = episodeForProfileDate(profileId, today(profileId));
  if (!ep || ep.end != null) return null;
  return assembleIllnessEpisode(profileId, ep);
}

// All of a profile's illness episodes, most-recent first — what the timeline lists a
// card per and the episodes index (#856 item 9) rows over. Each carries its stored row
// id + [start, end). The DB (idx_illness_episodes_profile) provides the ordering, so
// consumers no longer parse the situation-events JSON blob per profile per request.
export function allEpisodesForProfile(profileId: number): IllnessEpisode[] {
  return listEpisodeRows(profileId).map(episodeRowToDerived);
}
