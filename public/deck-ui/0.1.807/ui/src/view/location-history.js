import {h} from '../../vendor/preact.mjs';
import {useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Failure} from './page-state.js';
import {Glyph} from '../glyphs.js';
import {dateStrInTz, shiftDateStr, zonedWallTimeToUtc} from '../zoned.js';
import {dateText, DateTimeFormatter} from '../format.js';
const html = htm.bind(h);

export function locationDayBounds(day, timeZone) {
  return {since: zonedWallTimeToUtc(timeZone, day, '00:00').toISOString(),
    until: zonedWallTimeToUtc(timeZone, shiftDateStr(day, 1), '00:00').toISOString()};
}

/** Explicit date bounds also reach imported history; no third-party map receives positions. */
export function LocationHistory({host, timeZone = DateTimeFormatter().resolvedOptions().timeZone, now = new Date()}) {
  const today = dateStrInTz(timeZone, new Date(now));
  const [day, setDay] = useState(today);
  // a day back or forward, never past today
  const step = n => { const next = shiftDateStr(day, n); if (next <= today) { setDay(next); setState({rows: []}); } };
  const [state, setState] = useState({rows: []});
  async function load(more = false) {
    const {since, until} = locationDayBounds(day, timeZone);
    const rows = more ? state.rows : [];
    setState({...state, busy: true, error: null});
    try {
      const batch = await host.call('habitat.positions', {query: {since, until, limit: 100,
        ...(more ? {after: rows.at(-1).at} : {})}});
      setState({rows: [...rows, ...batch], more: batch.length === 100});
    } catch (error) { setState({rows, error}); }
  }
  const rows = state.rows;
  const coords = rows.filter(p => Number.isFinite(p.latitude) && Number.isFinite(p.longitude));
  const minLat = Math.min(...coords.map(p => p.latitude)), minLon = Math.min(...coords.map(p => p.longitude));
  const latSpan = Math.max(0.001, Math.max(...coords.map(p => p.latitude)) - minLat);
  const lonSpan = Math.max(0.001, Math.max(...coords.map(p => p.longitude)) - minLon);
  return html`<section class="dh-location" aria-label="Location history">
    <h2 class="dk-label">Location history</h2><div class="dh-location-pick">
      <div class="dh-day" role="group" aria-label="Day">
        <button type="button" class="dk-btn icon" aria-label="Previous day" disabled=${state.busy} onClick=${() => step(-1)}><${Glyph} name="prev" size=${16} /></button>
        <span class="dh-day-text" aria-live="polite">${dateText(day, {now: today, timeZone})}</span>
        <button type="button" class="dk-btn icon" aria-label="Next day" disabled=${state.busy || day >= today} onClick=${() => step(1)}><${Glyph} name="next" size=${16} /></button>
      </div>
      <button class="dk-btn" disabled=${state.busy || !day} onClick=${() => load()}>Show history</button></div>
    ${state.busy ? html`<p role="status">Loading locations…</p>` : null}
    ${state.error ? html`<${Failure} host=${host} backend="Habitat" error=${state.error} retry=${() => load()} />` : null}
    ${coords.length ? html`<svg viewBox="0 0 320 180" role="img" aria-label="Location trail, north up">
      <polyline fill="none" stroke="currentColor" stroke-width="2" points=${coords.map(p => `${10 + (p.longitude - minLon) / lonSpan * 300},${170 - (p.latitude - minLat) / latSpan * 160}`).join(' ')} />
      ${coords.map(p => html`<circle cx=${10 + (p.longitude - minLon) / lonSpan * 300} cy=${170 - (p.latitude - minLat) / latSpan * 160} r="3" fill="currentColor" />`)}
    </svg>` : html`<p>No locations loaded for this day.</p>`}
    <ol>${rows.map(p => html`<li key=${p.at}>${p.at} · ${p.state} · ${p.latitude}, ${p.longitude}${p.accuracyM == null ? '' : ` · ±${p.accuracyM} m`}</li>`)}</ol>
    ${state.more ? html`<button class="dk-btn" disabled=${state.busy} onClick=${() => load(true)}>Load more</button>` : null}
  </section>`;
}
