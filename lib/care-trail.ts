// The care-trail model (issue #1373 Part 2): the pure nesting/toggle/day-annotation
// engine behind the view-set-driven /medical/episodes surface.
//
// ONE computation, never a second derivation (#221):
//   • the day annotation on a nested linked visit / course is `episodeDayNumber` — the
//     SAME "Day N" math the cockpit uses;
//   • course membership in an episode is `classifyEpisodeMed` — the SAME window
//     classification the end-of-episode reconcile uses (lib/episode-med-reconcile.ts),
//     never a parallel "which meds belong" test;
//   • course completion honesty comes from the existing medication-history state
//     vocabulary only (Completed course / stopped / open) — no invented adherence %.
//
// PURE: no DB, no auth, no clock. The DB gather (lib/care-trail-gather.ts) composes the
// existing per-profile readers and hands their output here; per-profile timezone/day
// math (each episode's [rangeStart, rangeEndInclusive]) is resolved by the gather in the
// owning member's context and rides in on the input, so this module never evaluates one
// member's dates in another's context.

import { episodeDayNumber } from "./illness-episode-format";
import { daysBetweenDateStr } from "./date";
import {
  classifyEpisodeMed,
  type EpisodeMedClass,
} from "./episode-med-reconcile";
import { stopReasonLabel } from "./medication-history";
import type { MedStopReason } from "./types";

// ── Flat gathered inputs (one set per in-view member, then merged) ─────────────

export interface CareTrailEpisodeInput {
  profileId: number;
  episodeId: number;
  situation: string;
  firstDay: string | null;
  lastActiveDay: string | null;
  ongoing: boolean;
  dayCount: number | null;
  maxTempF: number | null;
  symptomLabels: string[];
  // The user-owned outcome annotation, or a derived condition hint — the same field the
  // former flat index rendered ("Self-resolved" / "Condition: …" / "Ongoing").
  outcome: string | null;
  promotedConditionName: string | null;
  // The episode-relative membership window (resolved per member, in its own timezone):
  // rangeStart = firstDay (null = before the change-log floor); rangeEndInclusive = the
  // last active day, or today() for an open episode. Fed straight to classifyEpisodeMed
  // so course membership is the reconcile's window classification.
  rangeStart: string | null;
  rangeEndInclusive: string;
  // The episode_encounters link set for this episode (#1198).
  linkedEncounterIds: number[];
}

export interface CareTrailVisitInput {
  profileId: number;
  encounterId: number;
  date: string;
  endDate: string | null;
  type: string | null;
  reason: string | null;
  providerId: number | null;
  providerName: string | null;
  locationName: string | null;
}

// A medication course as gathered for the trail. `startedOn` doubles as the membership
// date fed to classifyEpisodeMed (a course "created" during the episode window). The
// per-course prescriber (#1204) provider drives the visit-chain match.
export interface CareTrailCourseInput {
  profileId: number;
  courseId: number;
  itemId: number;
  medName: string;
  startedOn: string | null;
  stoppedOn: string | null;
  open: boolean;
  stopReason: MedStopReason | null;
  rx: boolean;
  asNeeded: boolean;
  prescriberProviderId: number | null;
  administrationDates: string[];
}

// ── Nested output shapes ──────────────────────────────────────────────────────

export interface CareTrailLinkedVisit {
  encounterId: number;
  date: string;
  type: string | null;
  reason: string | null;
  providerId: number | null;
  providerName: string | null;
  // Episode-relative day ("Day 2 — Urgent care, Dr. Ng"). Null when the episode start
  // is unknown (before-log episode).
  dayNumber: number | null;
}

export interface CareTrailNestedCourse {
  courseId: number;
  itemId: number;
  medName: string;
  startedOn: string | null;
  stoppedOn: string | null;
  open: boolean;
  klass: EpisodeMedClass;
  dayNumber: number | null;
  // The honest completion label from course state ONLY (Completed / Stopped / Open).
  stateLabel: string;
  // Whole days the course's own end runs PAST the episode's last active day (the
  // finish-your-antibiotics compliance tail). 0 when the course ends within the episode.
  overhangDays: number;
  // The linked visit whose provider matches this course's prescriber (#1204) — "prescribed
  // at the Day-2 urgent-care visit". Null when the prescriber matches no linked visit
  // (the course line then stands alone — never inferred).
  chainVisit: { encounterId: number; dayNumber: number | null } | null;
}

export interface CareTrailEpisode {
  kind: "episode";
  profileId: number;
  episodeId: number;
  situation: string;
  firstDay: string | null;
  lastActiveDay: string | null;
  ongoing: boolean;
  dayCount: number | null;
  maxTempF: number | null;
  symptomLabels: string[];
  outcome: string | null;
  promotedConditionName: string | null;
  linkedVisits: CareTrailLinkedVisit[];
  courses: CareTrailNestedCourse[];
  linkedVisitCount: number;
}

export interface CareTrailUnlinkedVisit {
  kind: "visit";
  profileId: number;
  encounterId: number;
  date: string;
  endDate: string | null;
  type: string | null;
  reason: string | null;
  providerName: string | null;
  locationName: string | null;
}

export type CareTrailRow = CareTrailEpisode | CareTrailUnlinkedVisit;

export type CareTrailKind = "illness" | "illness+visits";

export const CARE_TRAIL_KINDS: readonly CareTrailKind[] = [
  "illness",
  "illness+visits",
];

// Normalize an untrusted ?kind= value to the two-state toggle; default `illness`. The URL
// param carries `visits` for the illness+visits state (a literal `+` decodes to a space),
// but the internal state value stays `illness+visits`.
export function normalizeCareTrailKind(v: unknown): CareTrailKind {
  return v === "visits" || v === "illness+visits"
    ? "illness+visits"
    : "illness";
}

// ── Course state honesty (existing vocabulary only) ───────────────────────────

// The completion label for a nested course, from course state ONLY (#1373): an open
// course reads "Open"; a completed course "Completed"; any other stop its reason label.
// No invented adherence percentage.
export function courseStateLabel(course: {
  open: boolean;
  stopReason: MedStopReason | null;
}): string {
  if (course.open) return "Open";
  if (course.stopReason === "completed_course") return "Completed";
  return stopReasonLabel(course.stopReason);
}

// ── Day math + overhang (one computation) ─────────────────────────────────────

// Whole days a course's end runs past the episode's last active day (>= 0). A course
// with no stop date (open) or an episode with no last active day (ongoing / unknown)
// has no measurable overhang → 0.
export function courseOverhangDays(
  courseStoppedOn: string | null,
  episodeLastActiveDay: string | null
): number {
  if (!courseStoppedOn || !episodeLastActiveDay) return 0;
  const d = daysBetweenDateStr(episodeLastActiveDay, courseStoppedOn);
  return d != null && d > 0 ? d : 0;
}

// ── The nested build ──────────────────────────────────────────────────────────

// Build one episode's nested trail: its linked visits (in episode-relative day order)
// and its member courses (classifyEpisodeMed membership; prescriber↔linked-visit chain).
// `visitsByEncounterId` is the profile's full visit set keyed by id (for linked-visit
// resolution + provider match).
function buildEpisode(
  ep: CareTrailEpisodeInput,
  courses: CareTrailCourseInput[],
  visitsByEncounterId: Map<number, CareTrailVisitInput>
): CareTrailEpisode {
  // Linked visits, resolved from the episode_encounters set, earliest first (the care
  // trail reads PCP → urgent care → specialist → follow-up).
  const linkedVisits: CareTrailLinkedVisit[] = ep.linkedEncounterIds
    .map((eid) => visitsByEncounterId.get(eid))
    .filter((v): v is CareTrailVisitInput => v != null)
    .sort((a, b) =>
      a.date < b.date ? -1 : a.date > b.date ? 1 : a.encounterId - b.encounterId
    )
    .map((v) => ({
      encounterId: v.encounterId,
      date: v.date,
      type: v.type,
      reason: v.reason,
      providerId: v.providerId,
      providerName: v.providerName,
      dayNumber: episodeDayNumber(ep.firstDay, v.date),
    }));

  // A prescriber-provider → linked-visit index for the chain match. Only PROVABLE chains
  // render: a course whose prescriber provider id matches a linked visit's provider.
  const visitByProviderId = new Map<number, CareTrailLinkedVisit>();
  for (const lv of linkedVisits) {
    if (lv.providerId != null && !visitByProviderId.has(lv.providerId)) {
      visitByProviderId.set(lv.providerId, lv);
    }
  }

  // Course membership = classifyEpisodeMed's window classification (never a second
  // derivation). A course participates when classifyEpisodeMed(medInput, range) is
  // non-null, treating the course's start as the med's created date. hasOpenCourse is
  // set true so a historical (already-stopped) course is still classified by its window.
  const range = { start: ep.rangeStart, endInclusive: ep.rangeEndInclusive };
  const nestedCourses: CareTrailNestedCourse[] = [];
  for (const c of courses) {
    if (c.startedOn == null) continue;
    const classification = classifyEpisodeMed(
      {
        itemId: c.itemId,
        name: c.medName,
        asNeeded: c.asNeeded,
        rx: c.rx,
        hasOpenCourse: true,
        createdOn: c.startedOn,
        administrationDates: c.administrationDates,
      },
      range
    );
    if (!classification) continue;
    const chain =
      c.prescriberProviderId != null
        ? visitByProviderId.get(c.prescriberProviderId)
        : undefined;
    nestedCourses.push({
      courseId: c.courseId,
      itemId: c.itemId,
      medName: c.medName,
      startedOn: c.startedOn,
      stoppedOn: c.stoppedOn,
      open: c.open,
      klass: classification.klass,
      dayNumber: episodeDayNumber(ep.firstDay, c.startedOn),
      stateLabel: courseStateLabel({ open: c.open, stopReason: c.stopReason }),
      overhangDays: courseOverhangDays(c.stoppedOn, ep.lastActiveDay),
      chainVisit: chain
        ? { encounterId: chain.encounterId, dayNumber: chain.dayNumber }
        : null,
    });
  }
  // Courses in start order (earliest first) so they read down the illness narrative.
  nestedCourses.sort((a, b) =>
    (a.startedOn ?? "") < (b.startedOn ?? "")
      ? -1
      : (a.startedOn ?? "") > (b.startedOn ?? "")
        ? 1
        : a.courseId - b.courseId
  );

  return {
    kind: "episode",
    profileId: ep.profileId,
    episodeId: ep.episodeId,
    situation: ep.situation,
    firstDay: ep.firstDay,
    lastActiveDay: ep.lastActiveDay,
    ongoing: ep.ongoing,
    dayCount: ep.dayCount,
    maxTempF: ep.maxTempF,
    symptomLabels: ep.symptomLabels,
    outcome: ep.outcome,
    promotedConditionName: ep.promotedConditionName,
    linkedVisits,
    courses: nestedCourses,
    linkedVisitCount: linkedVisits.length,
  };
}

export interface CareTrailBuild {
  episodes: CareTrailEpisode[];
  unlinkedVisits: CareTrailUnlinkedVisit[];
}

// The whole build over the merged gathered inputs: every in-view episode nested with
// its linked visits + member courses, plus the set of UNLINKED visits (routine physicals,
// dental) held apart for the illness+visits lens. A visit linked to MULTIPLE episodes
// nests under EACH (the #1198 many-model) and is never counted as unlinked.
export function buildCareTrail(
  episodes: CareTrailEpisodeInput[],
  visits: CareTrailVisitInput[],
  courses: CareTrailCourseInput[]
): CareTrailBuild {
  const coursesByProfile = new Map<number, CareTrailCourseInput[]>();
  for (const c of courses) {
    const arr = coursesByProfile.get(c.profileId) ?? [];
    arr.push(c);
    coursesByProfile.set(c.profileId, arr);
  }
  const visitsByProfileEncounterId = new Map<
    number,
    Map<number, CareTrailVisitInput>
  >();
  for (const v of visits) {
    const m = visitsByProfileEncounterId.get(v.profileId) ?? new Map();
    m.set(v.encounterId, v);
    visitsByProfileEncounterId.set(v.profileId, m);
  }

  // Every encounter id that is linked to at least one episode → excluded from unlinked.
  const linkedEncounterIds = new Set<number>();
  for (const ep of episodes) {
    for (const eid of ep.linkedEncounterIds) linkedEncounterIds.add(eid);
  }

  const builtEpisodes = episodes.map((ep) =>
    buildEpisode(
      ep,
      coursesByProfile.get(ep.profileId) ?? [],
      visitsByProfileEncounterId.get(ep.profileId) ?? new Map()
    )
  );

  const unlinkedVisits: CareTrailUnlinkedVisit[] = visits
    .filter((v) => !linkedEncounterIds.has(v.encounterId))
    .map((v) => ({
      kind: "visit",
      profileId: v.profileId,
      encounterId: v.encounterId,
      date: v.date,
      endDate: v.endDate,
      type: v.type,
      reason: v.reason,
      providerName: v.providerName,
      locationName: v.locationName,
    }));

  return { episodes: builtEpisodes, unlinkedVisits };
}

// ── The chronological sort key + toggle partition ─────────────────────────────

export function careTrailRowSortDate(row: CareTrailRow): string {
  if (row.kind === "visit") return row.date;
  return row.firstDay ?? row.lastActiveDay ?? "";
}

// Most-recent first, ties broken deterministically (visits before episodes on the same
// day, then by id) — the same stable ordering as the merged household stream.
function sortRowsDesc(rows: CareTrailRow[]): CareTrailRow[] {
  return [...rows].sort((a, b) => {
    const da = careTrailRowSortDate(a);
    const db = careTrailRowSortDate(b);
    if (da !== db) return da < db ? 1 : -1;
    if (a.kind !== b.kind) return a.kind === "visit" ? -1 : 1;
    const ia = a.kind === "visit" ? a.encounterId : a.episodeId;
    const ib = b.kind === "visit" ? b.encounterId : b.episodeId;
    return ib - ia;
  });
}

// The two-state toggle partition: `illness` shows episodes only (with their nested
// linked visits + courses); `illness+visits` ADDS the unlinked visits as standalone
// interleaved rows. Linked visits are ALWAYS nested (present in both modes, never a
// standalone row) — there is deliberately no visits-only lens.
export function careTrailRows(
  build: CareTrailBuild,
  kind: CareTrailKind
): CareTrailRow[] {
  const rows: CareTrailRow[] = [...build.episodes];
  if (kind === "illness+visits") rows.push(...build.unlinkedVisits);
  return sortRowsDesc(rows);
}

// ── Per-member stats strip ────────────────────────────────────────────────────

export interface MemberEpisodeStats {
  profileId: number;
  episodeCount: number; // total episodes in view
  episodesThisYear: number; // firstDay year === current year
  avgDurationDays: number | null; // mean dayCount over episodes that carry one
  lastMonth: string | null; // YYYY-MM of the most recent episode's firstDay
}

// Per-member episode frequency stats ("Riley — 4 episodes this year · avg 5 days · last:
// March"). PURE over the same episodes the list renders (one computation). `currentYear`
// is passed in (resolved per the viewer's clock) so the module stays clock-free.
export function perMemberEpisodeStats(
  episodes: CareTrailEpisode[],
  currentYear: number
): MemberEpisodeStats[] {
  const byProfile = new Map<number, CareTrailEpisode[]>();
  for (const e of episodes) {
    const arr = byProfile.get(e.profileId) ?? [];
    arr.push(e);
    byProfile.set(e.profileId, arr);
  }
  const out: MemberEpisodeStats[] = [];
  for (const [profileId, eps] of byProfile) {
    const withDuration = eps.filter((e) => e.dayCount != null);
    const avg =
      withDuration.length > 0
        ? withDuration.reduce((s, e) => s + (e.dayCount ?? 0), 0) /
          withDuration.length
        : null;
    const days = eps
      .map((e) => e.firstDay)
      .filter((d): d is string => d != null)
      .sort();
    const lastDay = days.length ? days[days.length - 1] : null;
    out.push({
      profileId,
      episodeCount: eps.length,
      episodesThisYear: eps.filter(
        (e) =>
          e.firstDay != null && Number(e.firstDay.slice(0, 4)) === currentYear
      ).length,
      avgDurationDays: avg == null ? null : Math.round(avg),
      lastMonth: lastDay ? lastDay.slice(0, 7) : null,
    });
  }
  return out.sort((a, b) => a.profileId - b.profileId);
}
