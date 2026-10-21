// Health on allos (contract/health.md *Health*): the shared page header with the page switcher, then Deck's sections: today's doses as
// rows with their actions in fixed columns (Take and Skip while due, Undo once taken or skipped), readings and labs as stat tiles with their trend, records through the find/ask box, a
// reading form of fields with units.
import {HealthWorkflow} from './health-workflow.js';
import {healthWorkflows} from '../health-workflow.js';
import {dayText, labTiles, readingTiles} from '../health.js';
import {Failure, PageState} from './page-state.js';
import {StatusToast} from './health-workflow.js';
import {Button, Field} from './controls.js';
import {PageHeader} from './page-header.js';
import {FindBox} from './find-box.js';
import {RowList} from './rows.js';
import {StatTiles} from './stat-tiles.js';
import {h} from '../../vendor/preact.mjs';
import {useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {ShellBar} from './shell-bar.js';
const html = htm.bind(h);

const DESCRIPTION = 'Doses, readings, labs and records.';
// [field, label, unit, placeholder]: the device API's numeric fields in the units the form sends (kg, mg/dL, °C).
const READING = [['weight', 'Weight', 'kg', 'e.g. 72.5'], ['bodyFat', 'Body fat', '%', 'e.g. 18'], ['restingHr', 'Resting heart rate', 'bpm', 'e.g. 60'],
  ['systolic', 'Systolic', 'mmHg', 'e.g. 120'], ['diastolic', 'Diastolic', 'mmHg', 'e.g. 80'], ['glucose', 'Glucose', 'mg/dL', 'e.g. 95'],
  ['spo2', 'Oxygen saturation', '%', 'e.g. 98'], ['temperature', 'Temperature', '°C', 'e.g. 36.8']];

/** A section of the page: a label heading, an optional line beside it, then its content. */
export const HealthSection = ({label, meta, children, ...attrs}) => html`<section class="dh-sec" aria-label=${label} ...${attrs}>
  <h2 class="dh-head"><span class="dk-label">${label}</span>${meta ? html`<span class="dh-meta">${meta}</span>` : null}</h2>${children}</section>`;

function ReadingForm({health}) {
  return html`<${HealthSection} label="Log a reading"><form class="dh-reading" onSubmit=${ev => {
    ev.preventDefault();
    const data = new FormData(ev.currentTarget), body = {};
    for (const [key] of READING) if (data.get(key) !== '') body[key] = Number(data.get(key));
    if (body.glucose != null) body.glucoseUnit = 'mg/dL';
    if (body.temperature != null) body.tempUnit = 'C';
    if (Object.keys(body).length) health.logReading(body);
  }}><div class="dh-fields">${READING.map(([key, label, unit, placeholder]) => html`<${Field} key=${key} label=${label} unit=${unit} name=${key}
    type="number" inputmode="decimal" step="any" placeholder=${placeholder} />`)}</div>
  <div class="dh-form-acts"><${Button} variant="primary" class="dk-btn" disabled=${health.busy || health.loading}>Save reading</${Button}></div></form><//>`;
}

const STATE = {taken: ['Taken', 'ok'], skipped: ['Skipped', 'muted']};
function Doses({health: a, writable}) {
  const busy = a.busy || a.loading;
  return html`<${HealthSection} label="Today’s doses" meta=${[dayText(a.board?.day), a.board?.allDone ? 'All done' : null].filter(Boolean).join(' · ')}>
    ${!a.board?.meds?.length ? html`<${PageState} state="empty" inline hint="No scheduled doses." />` : html`<div class="dp-rows dp-plain dh-doses" role="list">
      ${a.board.meds.flatMap(m => m.doses.map(d => {
        const [state, dot] = STATE[d.status] ?? (d.status ? [d.status, 'muted'] : d.pastDue ? ['Past due', 'warn'] : ['Due', 'accent']);
        return html`<div class="dp-row bare dh-dose" role="listitem" key=${d.id} data-id=${d.id}>
          <span class=${`dp-dot dot-${dot}`} aria-hidden="true"></span>
          <span class="dp-lines"><span class="dp-title two">${m.name}</span>
            <span class="dp-sub"><span class=${`dh-dose-state ${dot}`}>${state}</span> · ${d.label} · ${d.timeOfDay}</span></span>
          ${writable ? html`<span class="dh-dose-acts">${d.status ? html`<span aria-hidden="true"></span><span aria-hidden="true"></span>
            <${Button} class="dk-btn" disabled=${busy} onClick=${() => a.dose(d.id, 'clear')}>Undo</${Button}>` : html`
            <${Button} class="dk-btn" disabled=${busy} onClick=${() => a.dose(d.id, 'take')}>Take</${Button}>
            <${Button} class="dk-btn" disabled=${busy} onClick=${() => a.dose(d.id, 'skip')}>Skip</${Button}><span aria-hidden="true"></span>`}</span>` : null}
        </div>`;
      }))}</div>`}<//>`;
}

function Records({health: a, host, open}) {
  const [q, setQ] = useState('');
  const results = a.results.map(r => ({id: r.key, glyph: 'document', title: r.title, sub: [r.subtitle, dayText(r.date)].filter(Boolean).join(' · '), record: r}));
  return html`<${HealthSection} label="Records">
    <${FindBox} label="Find or ask about records" placeholder="Find or ask about records" askLabel="Ask records" value=${q} onInput=${setQ}
      disabled=${a.loading} busy=${a.searching} onFind=${v => a.search(v)} onAsk=${v => a.search(v, true)} />
    ${a.answer ? html`<article class="dp-answer dh-answer" aria-label="Record answer"><div class="dp-answerhead"><span class="dk-label">Answer</span></div>
      <div class="dp-answertext">${a.answer.answer}</div>
      ${a.answer.offline ? html`<${Failure} backend="allos" error=${{code: 'unreachable'}} retry=${() => a.search(q, true)} host=${host} />` : null}</article>` : null}
    ${a.answer?.citations?.length ? html`<${RowList} items=${a.answer.citations.map(c => ({id: `c${c.index}`, glyph: 'document', title: c.title,
      sub: [c.subtitle, dayText(c.date)].filter(Boolean).join(' · ')}))} />` : null}
    ${results.length ? html`<${RowList} items=${results} onOpen=${it => open(it.record)} />` : null}<//>`;
}

export function Health({health: a, host, opts = {}}) {
  const [page, setPage] = useState('today');
  const shell = opts.nav ? html`<${ShellBar} nav=${opts.nav} current="health" />` : null;
  if (!a.owner) return html`<div>${shell}<main class="dhealth dk-page"><${PageHeader} title="Health" description=${DESCRIPTION} />
    <${PageState} state=${a.loading ? 'loading' : undefined} backend="allos" error=${a.loading ? null : a.error ?? (host.backends?.includes('allos') ? {status: 403} : {code: 'not-set-up'})} retry=${() => a.refresh()} host=${host} /></main></div>`;
  const writable = a.profiles?.find(p => p.id === a.profile)?.access === 'write';
  const open = r => opts.onRecord?.({key: r.key, title: r.title, profile: a.profile});
  const pages = html`<nav class="dh-pages" aria-label="Health pages">${[['today', 'Today'], ...Object.entries(healthWorkflows)].map(([id, label]) => html`<button key=${id} type="button"
    class=${`dk-chip${page === id ? ' on' : ''}`} aria-current=${page === id ? 'page' : undefined} disabled=${a.loading || a.busy} onClick=${() => setPage(id)}>${label}</button>`)}</nav>`;
  const readings = readingTiles(a.readings), labs = labTiles(a.labs);
  return html`<div class="dh-page">
    ${shell}
    <main class="dhealth dk-page" aria-busy=${a.loading}><${PageHeader} title="Health" description=${DESCRIPTION} tabs=${pages} actions=${html`<label class="dh-profile"><span>Profile</span>
      <select class="dk-field" aria-label="Profile" disabled=${a.loading || a.busy} value=${a.profile} onChange=${ev => a.refresh(a.profiles.find(p => String(p.id) === ev.target.value)?.id)}>
      ${(a.profiles ?? []).map(p => html`<option key=${p.id} value=${p.id}>${p.name ?? p.label}</option>`)}</select></label>
      <${Button} class="dk-btn" disabled=${a.loading || a.busy} onClick=${() => a.refresh()}>${a.loading ? 'Refreshing…' : 'Refresh'}</${Button}>`} />
    <${PageState} backend="allos" error=${a.error} retry=${() => a.refresh()} host=${host}>
    ${page !== 'today' ? (a.loading ? html`<${PageState} state="loading" />` : html`<${HealthWorkflow} key=${`${page}:${a.profile}`} kind=${page} profile=${a.profile} writable=${writable} host=${host} onRecord=${opts.onRecord} />`) : html`<div class="dh-today">
    <${Doses} health=${a} writable=${writable} />
    <${HealthSection} label="Readings">${readings.length ? html`<${StatTiles} label="Recent readings" tiles=${readings} />` : html`<${PageState} state="empty" inline hint="Log a reading to see it here." />`}<//>
    <${HealthSection} label="Labs">${labs.length ? html`<${StatTiles} label="Labs" tiles=${labs} />` : html`<${PageState} state="empty" inline hint="Lab results will appear after import." />`}<//>
    <${Records} key=${a.profile} health=${a} host=${host} open=${open} />
    ${writable ? html`<${ReadingForm} health=${a} />` : html`<p class="dh-note">Read-only profile</p>`}
    </div>`}
    <//></main><${StatusToast} text=${a.status} bad=${a.statusBad} host=${host} /></div>`;
}
