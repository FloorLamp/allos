// The care-trail DB gather (issue #1373 Part 2). Auth-blind, profileId-LIST-first — the
// same contract lib/household-history.ts established: takes the ALREADY-RESOLVED set of
// in-view profile ids (scope.viewIds) and composes the existing per-profile readers into
// the flat inputs the pure care-trail engine (lib/care-trail.ts) nests. It never imports
// lib/auth; the auth decision stays at the page via requireScope().
//
// #879 accounting: gatherHouseholdHistory survives intact (still powering
// isHouseholdRecentlySick + the episode-detail context). This gather is the RICHER feed
// the consolidated surface needs — the same episodes/visits PLUS the episode_encounters
// link set, medication courses, and per-course prescriber (#1204) — so linked-visit
// nesting, course membership, and the visit chain resolve here.
//
// profileId-LIST-first, NOT set-based: it LOOPS the per-profile readers (each read is
// profile-scoped by `= ?` or a JOIN to the parent), so it introduces no `WHERE profile_id
// IN (…)` SQL and needs no CROSS_PROFILE_SQL_MODULES registration (same as
// household-history). Per-profile timezone/day math (each episode's [rangeStart,
// rangeEndInclusive]) is resolved HERE in the owning member's context via today(pid).

import { db, today } from "./db";
import { summarizeEpisodesForProfile } from "./illness-episode-summary";
import { getEncounters } from "./queries/medical";
import { linkedEncounterIdsForEpisode } from "./queries/visit-links";
import type {
  CareTrailEpisodeInput,
  CareTrailVisitInput,
  CareTrailCourseInput,
} from "./care-trail";
import type { MedStopReason } from "./types";

interface MedRow {
  id: number;
  name: string;
  as_needed: number;
  rx: number;
}
interface CourseRow {
  id: number;
  item_id: number;
  started_on: string | null;
  stopped_on: string | null;
  stop_reason: MedStopReason | null;
  provider_id: number | null;
}

// The profile's medications + their courses + 'taken' administration dates, all
// profile-scoped (direct profile_id, or a JOIN to the parent intake_items). Assembled
// into CareTrailCourseInput rows the engine classifies via classifyEpisodeMed.
function coursesForProfile(profileId: number): CareTrailCourseInput[] {
  const meds = db
    .prepare(
      `SELECT id, name, as_needed, rx
         FROM intake_items
        WHERE profile_id = ? AND kind = 'medication'`
    )
    .all(profileId) as MedRow[];
  if (meds.length === 0) return [];
  const medById = new Map(meds.map((m) => [m.id, m]));

  const courses = db
    .prepare(
      `SELECT c.id, c.item_id, c.started_on, c.stopped_on, c.stop_reason,
              c.provider_id
         FROM medication_courses c
         JOIN intake_items ii ON ii.id = c.item_id
        WHERE ii.profile_id = ? AND ii.kind = 'medication'`
    )
    .all(profileId) as CourseRow[];
  if (courses.length === 0) return [];

  const adminRows = db
    .prepare(
      `SELECT l.item_id AS item_id, l.date AS date
         FROM intake_item_logs l
         JOIN intake_items ii ON ii.id = l.item_id
        WHERE ii.profile_id = ? AND ii.kind = 'medication'
          AND l.status = 'taken'`
    )
    .all(profileId) as { item_id: number; date: string }[];
  const datesByItem = new Map<number, string[]>();
  for (const r of adminRows) {
    const arr = datesByItem.get(r.item_id) ?? [];
    arr.push(r.date);
    datesByItem.set(r.item_id, arr);
  }

  const out: CareTrailCourseInput[] = [];
  for (const c of courses) {
    const med = medById.get(c.item_id);
    if (!med) continue;
    out.push({
      profileId,
      courseId: c.id,
      itemId: c.item_id,
      medName: med.name,
      startedOn: c.started_on,
      stoppedOn: c.stopped_on,
      open: c.stopped_on == null,
      stopReason: c.stop_reason,
      rx: med.rx === 1,
      asNeeded: med.as_needed === 1,
      prescriberProviderId: c.provider_id,
      administrationDates: datesByItem.get(c.item_id) ?? [],
    });
  }
  return out;
}

export interface CareTrailGather {
  episodes: CareTrailEpisodeInput[];
  visits: CareTrailVisitInput[];
  courses: CareTrailCourseInput[];
}

// THE gather. Every in-view member's illness episodes (with their episode_encounters
// link set + per-member membership window), visits (with provider id for the chain
// match), and medication courses — flat, ready for buildCareTrail. Bounded per-profile
// work, the same cost shape as the household dashboard loop.
export function gatherCareTrail(profileIds: number[]): CareTrailGather {
  const episodes: CareTrailEpisodeInput[] = [];
  const visits: CareTrailVisitInput[] = [];
  const courses: CareTrailCourseInput[] = [];

  for (const pid of profileIds) {
    const todayStr = today(pid);
    for (const e of summarizeEpisodesForProfile(pid)) {
      // The membership window in THIS member's context: an open episode runs to its own
      // today(); a closed episode to its last active day (== reconcile's ended_at-1).
      const rangeEndInclusive = e.ongoing
        ? todayStr
        : (e.lastActiveDay ?? todayStr);
      episodes.push({
        profileId: pid,
        episodeId: e.id,
        situation: e.situation,
        firstDay: e.firstDay,
        lastActiveDay: e.lastActiveDay,
        ongoing: e.ongoing,
        dayCount: e.dayCount,
        maxTempF: e.maxTempF,
        symptomLabels: e.symptomLabels,
        outcome: e.outcome,
        promotedConditionName: e.promotedConditionName,
        rangeStart: e.firstDay,
        rangeEndInclusive,
        linkedEncounterIds: linkedEncounterIdsForEpisode(pid, e.id),
      });
    }
    for (const enc of getEncounters(pid)) {
      visits.push({
        profileId: pid,
        encounterId: enc.id,
        date: enc.date,
        endDate: enc.end_date,
        type: enc.type,
        reason: enc.reason,
        providerId: enc.provider_id,
        providerName: enc.provider_name,
        locationName: enc.location_name,
      });
    }
    courses.push(...coursesForProfile(pid));
  }

  return { episodes, visits, courses };
}
