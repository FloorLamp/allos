// Runs over time (contract/media.md *Runs*), no DOM: the days of a window in the house's zone, the minutes in use each hour of each day,
// how many started each week, and the summary's longest, average and last. view/runs.js draws them.
import {DateTimeFormatter} from './format.js';
import {dateStrInTz, shiftDateStr, zonedWallTimeToUtc} from './zoned.js';

const zoneOf = timeZone => timeZone ?? DateTimeFormatter().resolvedOptions().timeZone;
const at = (tz, day, hour) => +zonedWallTimeToUtc(tz, day, `${String(hour).padStart(2, '0')}:00`);

/** A run's start and end in ms (a running one ends now) and its minutes; null when it has no start. */
export function span(s, now) {
  const start = Date.parse(s.start), end = s.end ? Date.parse(s.end) : +now;
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return {start, end, running: !s.end, minutes: Number.isFinite(s.minutes) && s.end ? s.minutes : Math.round((end - start) / 60000)};
}

/** The window: `days` days ending today in `timeZone`, oldest first, and when it starts (that first day's midnight). */
export function runsWindow({now = Date.now(), timeZone, days = 30} = {}) {
  const tz = zoneOf(timeZone), today = dateStrInTz(tz, new Date(now));
  const list = Array.from({length: days}, (_, i) => shiftDateStr(today, i - days + 1));
  return {tz, days: list, since: at(tz, list[0], 0), until: +now};
}

/** The heat strip: minutes in use in each hour of each day (`cells[day][hour]`), local hours: the fall change's repeated 1 AM holds
 *  up to 120, the spring change's skipped 2 AM none. */
export function runsGrid(sessions, opts = {}) {
  const w = runsWindow(opts), now = opts.now ?? Date.now();
  const spans = (sessions ?? []).map(s => span(s, now)).filter(s => s && s.end > w.since);
  const cells = w.days.map(day => Array.from({length: 24}, (_, hr) => {
    const from = at(w.tz, day, hr), to = hr === 23 ? at(w.tz, shiftDateStr(day, 1), 0) : at(w.tz, day, hr + 1);
    if (!(to > from)) return 0;
    let ms = 0;
    for (const s of spans) ms += Math.max(0, Math.min(to, s.end) - Math.max(from, s.start));
    return Math.round(ms / 60000);
  }));
  return {...w, cells};
}

/** Runs started each Monday week the window touches, oldest first: [{week (its Monday), count}]. */
export function runsWeeks(sessions, opts = {}) {
  const w = runsWindow(opts), now = opts.now ?? Date.now();
  const monday = day => shiftDateStr(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
  const weeks = [...new Set(w.days.map(monday))].map(week => ({week, count: 0}));
  for (const s of sessions ?? []) {
    const sp = span(s, now);
    if (!sp || sp.start < w.since || sp.start > w.until) continue;
    const week = weeks.find(x => x.week === monday(dateStrInTz(w.tz, new Date(sp.start))));
    if (week) week.count += 1;
  }
  return weeks;
}

/** The summary of the runs started in the window: how many, the longest (and when), the average minutes, the last (running or not). */
export function runsSummary(sessions, opts = {}) {
  const w = runsWindow(opts), now = opts.now ?? Date.now();
  const inWindow = (sessions ?? []).map(s => span(s, now)).filter(s => s && s.start >= w.since && s.start <= w.until).sort((a, b) => b.start - a.start);
  if (!inWindow.length) return {count: 0, longest: null, average: null, last: null};
  const longest = inWindow.reduce((b, s) => (s.minutes > b.minutes ? s : b));
  const done = inWindow.filter(s => !s.running);
  return {count: inWindow.length, longest, last: inWindow[0],
    average: done.length ? Math.round(done.reduce((n, s) => n + s.minutes, 0) / done.length) : null};
}
