// The care-trail swimlane layout math (issue #1373 Part 2). PURE geometry over the
// already-built care trail: a trailing-window horizontal time axis (left→right), one
// lane per in-view member, illness episodes as duration bars and visits as point
// markers on the SAME axis so same-date = same-x (cross-member overlap is geometry).
//
// Link-awareness (product-decided): a LINKED visit's marker sits ON its episode's bar
// (inside the span); an UNLINKED visit sits on the lane baseline. A course renders as a
// thin sub-bar beneath its episode spanning its own start→end — an overhang past the
// episode end stays visible (the finish-your-antibiotics compliance tail).
//
// No DB, no clock — the window [start, end] is resolved by the caller (the viewer's
// trailing 12 / mobile 3–4 months) and passed in. Positions are percentages (0–100) of
// the window; anything fully outside the window is dropped (it still lists below).

import { daysBetweenDateStr } from "./date";
import type { CareTrailBuild, CareTrailEpisode } from "./care-trail";

export interface SwimlaneWindow {
  start: string;
  end: string;
  spanDays: number;
}

export interface SwimlaneVisitMarker {
  encounterId: number;
  pct: number; // 0–100 across the window
  type: string | null;
  dayNumber: number | null; // episode-relative (linked markers only), else null
}

export interface SwimlaneCourseBar {
  courseId: number;
  medName: string;
  leftPct: number;
  widthPct: number;
  overhang: boolean; // the course runs past the episode's last active day
}

export interface SwimlaneEpisodeBar {
  episodeId: number;
  situation: string;
  ongoing: boolean;
  maxTempF: number | null;
  leftPct: number;
  widthPct: number;
  visitMarkers: SwimlaneVisitMarker[]; // linked visits, ON the bar
  courseBars: SwimlaneCourseBar[];
}

export interface SwimlaneLane {
  profileId: number;
  episodes: SwimlaneEpisodeBar[];
  visitMarkers: SwimlaneVisitMarker[]; // unlinked visits, on the baseline
}

export interface Swimlane {
  window: SwimlaneWindow;
  lanes: SwimlaneLane[];
  // False when no lane has any bar or marker in the window — the band then collapses
  // (the absent-pillar rule: no empty grids).
  hasData: boolean;
}

// A date's fractional position (0–100) across the window, or null when it falls outside
// [start, end]. A minimum-width bar handles a same-day (start === end) window defensively.
function datePct(
  date: string | null,
  win: SwimlaneWindow
): number | null {
  if (!date) return null;
  if (date < win.start || date > win.end) return null;
  if (win.spanDays <= 0) return 0;
  const d = daysBetweenDateStr(win.start, date);
  if (d == null) return null;
  return Math.max(0, Math.min(100, (d / win.spanDays) * 100));
}

// A bar for a [from, to] range clamped to the window: { leftPct, widthPct } or null when
// the range doesn't intersect the window at all. `to` defaults to the window end for an
// open range (ongoing episode / open course).
function clampBar(
  from: string | null,
  to: string | null,
  win: SwimlaneWindow
): { leftPct: number; widthPct: number } | null {
  if (!from) return null;
  const start = from < win.start ? win.start : from;
  const rawEnd = to ?? win.end;
  const end = rawEnd > win.end ? win.end : rawEnd;
  if (start > win.end || end < win.start || start > end) return null;
  const leftPct = datePct(start, win) ?? 0;
  const endPct = datePct(end, win) ?? 100;
  return { leftPct, widthPct: Math.max(0.75, endPct - leftPct) };
}

const MIN_MARKER = 0.75; // a visit is a point; give it a tiny visible width elsewhere

export function buildSwimlane(
  build: CareTrailBuild,
  memberOrder: number[],
  windowStart: string,
  windowEnd: string
): Swimlane {
  const spanDays = daysBetweenDateStr(windowStart, windowEnd) ?? 0;
  const win: SwimlaneWindow = {
    start: windowStart,
    end: windowEnd,
    spanDays,
  };

  const episodesByProfile = new Map<number, CareTrailEpisode[]>();
  for (const e of build.episodes) {
    const arr = episodesByProfile.get(e.profileId) ?? [];
    arr.push(e);
    episodesByProfile.set(e.profileId, arr);
  }
  const unlinkedByProfile = new Map<number, typeof build.unlinkedVisits>();
  for (const v of build.unlinkedVisits) {
    const arr = unlinkedByProfile.get(v.profileId) ?? [];
    arr.push(v);
    unlinkedByProfile.set(v.profileId, arr);
  }

  let hasData = false;
  const lanes: SwimlaneLane[] = memberOrder.map((profileId) => {
    const eps = episodesByProfile.get(profileId) ?? [];
    const episodeBars: SwimlaneEpisodeBar[] = [];
    for (const ep of eps) {
      const bar = clampBar(ep.firstDay, ep.lastActiveDay, win);
      if (!bar) continue;
      hasData = true;
      const visitMarkers: SwimlaneVisitMarker[] = [];
      for (const lv of ep.linkedVisits) {
        const pct = datePct(lv.date, win);
        if (pct == null) continue;
        visitMarkers.push({
          encounterId: lv.encounterId,
          pct,
          type: lv.type,
          dayNumber: lv.dayNumber,
        });
      }
      const courseBars: SwimlaneCourseBar[] = [];
      for (const c of ep.courses) {
        const cb = clampBar(c.startedOn, c.stoppedOn, win);
        if (!cb) continue;
        courseBars.push({
          courseId: c.courseId,
          medName: c.medName,
          leftPct: cb.leftPct,
          widthPct: cb.widthPct,
          overhang: c.overhangDays > 0,
        });
      }
      episodeBars.push({
        episodeId: ep.episodeId,
        situation: ep.situation,
        ongoing: ep.ongoing,
        maxTempF: ep.maxTempF,
        leftPct: bar.leftPct,
        widthPct: bar.widthPct,
        visitMarkers,
        courseBars,
      });
    }

    const visitMarkers: SwimlaneVisitMarker[] = [];
    for (const v of unlinkedByProfile.get(profileId) ?? []) {
      const pct = datePct(v.date, win);
      if (pct == null) continue;
      hasData = true;
      visitMarkers.push({
        encounterId: v.encounterId,
        pct,
        type: v.type,
        dayNumber: null,
      });
    }

    return { profileId, episodes: episodeBars, visitMarkers };
  });

  return { window: win, lanes, hasData };
}

export { MIN_MARKER };
