// Runs over time (contract/media.md *Runs*): when something was in use: a day-by-hour heat strip (a column a day, oldest left; a row
// an hour, midnight at the top; a cell as dark as the minutes in use), a bar a week of how many started, the summary, and a hidden
// table of every run. Plain SVG sized to its box, colours from tokens.css. `EntityRuns` reads a Habitat entity's sessions for it.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {countText, dateText, dateTimeText, joinText, timeText} from '../format.js';
import {durationText} from '../quantity.js';
import {runsGrid, runsSummary, runsWeeks, runsWindow, span} from '../runs.js';
import {useBoxWidth} from './chart.js';
import {Failure, Skeleton} from './page-state.js';

const html = htm.bind(h);
const AXIS = 40, ROW = 6, WEEKS_H = 64, BAR_H = 26, BAR_Y = 44;
const minutesText = m => durationText(Math.max(1, m) * 60);
// a cell's shade: nothing, a few minutes, up to half the hour, most of it, all of it (the fall change's long 1 AM: past an hour)
const shade = m => (m <= 0 ? 0 : m < 10 ? 1 : m < 30 ? 2 : m < 50 ? 3 : 4);

/** The summary's words: `12 runs in 30 days · longest 1h 12m (Oct 3) · average 38m · last Oct 19, 7:05 PM, 24m`. */
export function runsText(sessions, {now = Date.now(), timeZone, days = 30, noun = ['run', 'runs']} = {}) {
  const s = runsSummary(sessions, {now, timeZone, days});
  if (!s.count) return `No ${noun[1]} in the last ${days} days`;
  const when = t => dateTimeText(new Date(t), {now, timeZone});
  return joinText([`${countText(s.count)} ${s.count === 1 ? noun[0] : noun[1]} in ${days} days`,
    s.count > 1 ? `longest ${minutesText(s.longest.minutes)} (${dateText(new Date(s.longest.start), {now, timeZone})})` : null,
    s.average != null && s.count > 1 ? `average ${minutesText(s.average)}` : null,
    s.last.running ? `running since ${when(s.last.start)}, ${minutesText(s.last.minutes)} so far` : `last ${when(s.last.start)}, ${minutesText(s.last.minutes)}`]);
}

/** sessions: [{start, end, minutes?}] (ISO; end null while it runs); days: the window ending today; noun: [one, many]; label: what ran. */
export function Runs({sessions = [], now = Date.now(), timeZone, days = 30, label = 'Runs', noun = ['run', 'runs']}) {
  const box = useRef(null);
  const [width, setWidth] = useState(0), [focus, setFocus] = useState(null);
  useBoxWidth(box, setWidth);
  const grid = runsGrid(sessions, {now, timeZone, days}), weeks = runsWeeks(sessions, {now, timeZone, days});
  const summary = runsText(sessions, {now, timeZone, days, noun}), count = runsSummary(sessions, {now, timeZone, days}).count;
  const w = runsWindow({now, timeZone, days});
  const listed = sessions.map(s => ({s, sp: span(s, now)})).filter(x => x.sp && x.sp.end > w.since).sort((a, b) => b.sp.start - a.sp.start);
  let strip = null, bars = null;
  if (width && count) {
    const col = (width - AXIS) / grid.days.length, every = Math.max(1, Math.ceil(56 / col));
    strip = html`<svg class="dr-strip" width=${width} height=${24 * ROW + 18} viewBox=${`0 0 ${width} ${24 * ROW + 18}`} aria-hidden="true" focusable="false">
      ${[0, 6, 12, 18].map(hr => html`<text key=${`h${hr}`} class="dc-tick" x=${AXIS - 6} y=${hr * ROW + 8} text-anchor="end">${['12 AM', '6 AM', '12 PM', '6 PM'][hr / 6]}</text>`)}
      ${grid.days.map((day, i) => html`<g key=${day} data-day=${day}>
        <rect class="dr-day" x=${AXIS + i * col} y="0" width=${Math.max(1, col - 1)} height=${24 * ROW} />
        ${grid.cells[i].map((m, hr) => (m ? html`<rect key=${hr} class=${`dr-c dr-c${shade(m)}`} data-minutes=${m} x=${AXIS + i * col} y=${hr * ROW} width=${Math.max(1, col - 1)} height=${ROW - 1} />` : null))}
        ${(grid.days.length - 1 - i) % every === 0 ? html`<text class="dc-tick" x=${i === grid.days.length - 1 ? AXIS + (i + 1) * col : AXIS + (i + 0.5) * col} y=${24 * ROW + 14}
          text-anchor=${i === grid.days.length - 1 ? 'end' : 'middle'}>${dateText(day, {now: day})}</text>` : null}
        <rect class="dc-hit" x=${AXIS + i * col} y="0" width=${col} height=${24 * ROW} onPointerEnter=${ev => { if (ev.pointerType === 'mouse') setFocus(day); }} onClick=${() => setFocus(day)} />
      </g>`)}
    </svg>`;
    const most = Math.max(1, ...weeks.map(x => x.count)), bw = Math.min(48, (width - AXIS) / weeks.length - 8);
    bars = html`<svg class="dr-weeks" width=${width} height=${WEEKS_H} viewBox=${`0 0 ${width} ${WEEKS_H}`} aria-hidden="true" focusable="false">
      <text class="dc-tick" x=${AXIS - 6} y=${BAR_Y - 6} text-anchor="end">Weekly</text>
      ${weeks.map((x, i) => {
        const cx = AXIS + ((width - AXIS) / weeks.length) * (i + 0.5), hgt = Math.max(2, (x.count / most) * BAR_H);
        return html`<g key=${x.week} data-week=${x.week} data-count=${x.count}>
          ${x.count ? html`<rect class="dr-bar" x=${cx - bw / 2} y=${BAR_Y - hgt} width=${bw} height=${hgt} rx="2" />` : html`<line class="dc-zero" x1=${cx - bw / 2} x2=${cx + bw / 2} y1=${BAR_Y} y2=${BAR_Y} />`}
          <text class="dc-tick dr-n" x=${cx} y=${BAR_Y - (x.count ? hgt : 0) - 4} text-anchor="middle">${x.count}</text>
          <text class="dc-tick" x=${cx} y=${BAR_Y + 14} text-anchor="middle">${dateText(x.week, {now: x.week})}</text></g>`;
      })}
    </svg>`;
  }
  const dayRuns = focus ? listed.filter(x => dateTextIn(x.sp.start, timeZone) === focus) : [];
  return html`<figure class="dc dr" aria-label=${label} data-runs=${count}>
    <div class="ds-top"><span class="ds-name">${label}</span></div>
    <p class="ds-summary dr-summary">${summary}</p>
    <div class="dc-box dr-box" ref=${box} hidden=${!count}>${strip}${bars}</div>
    ${focus && count ? html`<div class="dc-tip" role="status" data-day=${focus}><div class="dc-tiphead"><b>${dateText(focus, {now: dateTextIn(now, timeZone), weekday: true})}</b></div>
      <div class="dc-tiprow">${dayRuns.length ? dayRuns.map(x => html`<span class="dc-tipval" key=${x.sp.start}>${timeText(x.sp.start, {timeZone})}${x.sp.running ? '–now' : `–${timeText(x.sp.end, {timeZone})}`} <b>${minutesText(x.sp.minutes)}</b></span>`)
        : html`<span class="dc-tipval">No ${noun[1]}</span>`}</div></div>` : null}
    <div class="dk-sr"><table><caption>${label}, the last ${days} days</caption>
      <thead><tr><th>Started</th><th>Ended</th><th>Minutes</th></tr></thead>
      <tbody>${listed.map(x => html`<tr key=${x.sp.start}><td>${dateTimeText(new Date(x.sp.start), {now, timeZone})}</td><td>${x.sp.running ? 'running' : dateTimeText(new Date(x.sp.end), {now, timeZone})}</td><td>${x.sp.minutes}</td></tr>`)}</tbody></table></div>
  </figure>`;
}
const dateTextIn = (t, timeZone) => runsWindow({now: t, timeZone, days: 1}).days[0];

/** A Habitat entity's runs (contract/media.md *Runs*): `habitat.sessions` from the window's start, following `next` until it is covered. */
export function EntityRuns({host, entity, days = 30, timeZone, noun, label, now: fixed = null}) {
  const [state, setState] = useState({loading: true}), [retry, setRetry] = useState(0);
  useEffect(() => {
    let active = true;
    const now = fixed ?? Date.now(), {since} = runsWindow({now, timeZone, days});
    setState({loading: true, now});
    (async () => {
      const sessions = [];
      let until = null;
      for (let page = 0; page < 5; page += 1) {
        const answer = await host.call('habitat.sessions', {query: {id: entity, since: new Date(since).toISOString(), limit: 200, ...(until ? {until} : {})}});
        sessions.push(...(answer?.sessions ?? []));
        if (!answer?.next) break;
        until = answer.next;
      }
      return sessions;
    })().then(sessions => { if (active) setState({sessions, now}); }, error => { if (active) setState({error, now}); });
    return () => { active = false; };
  }, [host, entity, days, retry]);
  if (state.error) return state.error.code === 'unsupported' || state.error.code === 'not-set-up' ? null
    : html`<${Failure} backend="Habitat" error=${state.error} retry=${() => setRetry(n => n + 1)} host=${host} />`;
  if (state.loading) return html`<${Skeleton} inline=${true} />`;
  return html`<${Runs} sessions=${state.sessions} now=${state.now} timeZone=${timeZone} days=${days} noun=${noun} label=${label} />`;
}
