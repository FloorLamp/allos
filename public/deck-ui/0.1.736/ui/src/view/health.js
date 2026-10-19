import {HealthWorkflow} from './health-workflow.js';
import {healthWorkflows} from '../health-workflow.js';
import {PageState} from './page-state.js';
import {Button, Field} from './controls.js';
import {PageHeader} from './page-header.js';
import {Failure} from './failure.js';
import {StatusLink} from './page-state.js';
import {h} from '../../vendor/preact.mjs';
import {useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {ShellBar} from './shell-bar.js';
const html = htm.bind(h);

const READING = [['weight', 'Weight (kg)'], ['bodyFat', 'Body fat (%)'], ['restingHr', 'Resting heart rate (bpm)'],
  ['systolic', 'Systolic (mmHg)'], ['diastolic', 'Diastolic (mmHg)'], ['glucose', 'Glucose (mg/dL)'],
  ['spo2', 'Oxygen saturation (%)'], ['temperature', 'Temperature (°C)']];
function ReadingForm({health}) {
  return html`<form class="dh-reading" onSubmit=${ev => {
    ev.preventDefault();
    const data = new FormData(ev.currentTarget), body = {};
    for (const [key] of READING) if (data.get(key) !== '') body[key] = Number(data.get(key));
    if (body.glucose != null) body.glucoseUnit = 'mg/dL';
    if (body.temperature != null) body.tempUnit = 'C';
    if (Object.keys(body).length) health.logReading(body);
  }}><h2>Log a reading</h2><div class="dh-fields">${READING.map(([key, label]) => html`<${Field} key=${key} label=${label} name=${key} type="number" step="any" />`)}</div>
  <${Button} class="dk-btn" disabled=${health.busy || health.loading}>Save reading</${Button}></form>`;
}
export function Health({health: a, host, opts = {}}) {
  const [q, setQ] = useState('');
  const [page, setPage] = useState('today');
  const shell = opts.nav ? html`<${ShellBar} nav=${opts.nav} current="health" />` : null;
  if (!a.owner) return html`<div>${shell}<main class="dhealth dk-page"><${PageHeader} title="Health" description="Doses, readings, labs and records." />
    <${PageState} state=${a.loading ? 'loading' : undefined} backend="allos" error=${a.loading ? null : a.error ?? (host.backends?.includes('allos') ? {status: 403} : {code: 'not-set-up'})} retry=${() => a.refresh()} host=${host} /></main></div>`;
  const writable = a.profiles?.find(p => p.id === a.profile)?.access === 'write';
  const open = r => opts.onRecord?.({key: r.key, title: r.title, profile: a.profile});
  return html`<div class="dh-page">
    ${shell}
    <main class="dhealth dk-page" aria-busy=${a.loading}><${PageHeader} title="Health" description="Doses, readings, labs and records." actions=${html`<label>Profile <select aria-label="Profile" disabled=${a.loading || a.busy} value=${a.profile} onChange=${ev => a.refresh(a.profiles.find(p => String(p.id) === ev.target.value)?.id)}>
      ${(a.profiles ?? []).map(p => html`<option key=${p.id} value=${p.id}>${p.name ?? p.label}</option>`)}</select></label>
      <${Button} class="dk-btn" disabled=${a.loading || a.busy} onClick=${() => a.refresh()}>${a.loading ? 'Refreshing…' : 'Refresh'}</${Button}>`} />
    <${PageState} backend="allos" error=${a.error} retry=${() => a.refresh()} host=${host}>
    <nav aria-label="Health pages">${[['today', 'Today'], ...Object.entries(healthWorkflows)].map(([id, label]) => html`<${Button} key=${id} type="button" aria-current=${page === id ? 'page' : undefined} disabled=${a.loading || a.busy} onClick=${() => setPage(id)}>${label}</${Button}>`)}</nav>
    ${page !== 'today' ? (a.loading ? html`<${PageState} state="loading" />` : html`<${HealthWorkflow} key=${`${page}:${a.profile}`} kind=${page} profile=${a.profile} writable=${writable} host=${host} onRecord=${opts.onRecord} />`) : html`<div>
    <section><h2>Today’s doses</h2><p>${a.board?.day} ${a.board?.allDone ? '· All done' : ''}</p>
      ${!a.board?.meds?.length ? html`<${PageState} state="empty" hint="No scheduled doses." />` : a.board.meds.map(m => html`<div key=${m.id}><h3>${m.name}</h3>
        ${m.doses.map(d => html`<div class="dh-dose" key=${d.id}><span>${d.label} · ${d.timeOfDay}${d.pastDue && !d.status ? ' · Past due' : ''}</span>
          <span>${d.status ?? 'Due'}</span>${writable ? html`<${Button} class="dk-btn" disabled=${a.busy || a.loading} onClick=${() => a.dose(d.id, 'take')}>Take</${Button}>
          <${Button} class="dk-btn" disabled=${a.busy || a.loading} onClick=${() => a.dose(d.id, 'skip')}>Skip</${Button}>${d.status ? html`<${Button} class="dk-btn" disabled=${a.busy || a.loading} onClick=${() => a.dose(d.id, 'clear')}>Undo</${Button}>` : null}` : null}</div>`)}</div>`)}
    </section>
    <div class="dh-columns"><section><h2>Recent readings</h2>${a.readings.length ? a.readings.map((r, i) => html`<p key=${i}><b>${r.kind.replaceAll('_', ' ')}</b> · ${r.value ?? `${r.systolic}/${r.diastolic}`} ${r.unit}<small>${r.date} ${r.freshness ?? ''}</small></p>`) : html`<${PageState} state="empty" hint="Log a reading to see it here." />`}</section>
    <section><h2>Labs</h2>${a.labs.length ? a.labs.map((l, i) => html`<p key=${i}><b>${l.name}</b> · ${l.value} ${l.unit} · ${l.flag}<small>${l.date} ${l.freshness ?? ''}</small></p>`) : html`<${PageState} state="empty" hint="Lab results will appear after import." />`}</section></div>
    <section><h2>Records</h2><form onSubmit=${ev => { ev.preventDefault(); a.search(q); }}><label>Find or ask about records<input class="dk-field" type="search" value=${q} onInput=${ev => setQ(ev.target.value)} /></label>
      <${Button} class="dk-btn" disabled=${a.loading || !q.trim()}>Find records</${Button}> <${Button} class="dk-btn" type="button" disabled=${a.loading || !q.trim()} onClick=${() => a.search(q, true)}>Ask records</${Button}></form>
      ${a.results.map(r => html`<${Button} key=${r.key} class="dh-result dk-btn" disabled=${a.loading} onClick=${() => open(r)}>${r.title} · ${r.subtitle} · ${r.date}</${Button}>`)}
      ${a.answer ? html`<article aria-label="Record answer"><p>${a.answer.answer}</p>${a.answer.offline ? html`<${Failure} backend="allos" error=${{code: 'unreachable'}} retry=${() => a.search(q, true)} host=${host} />` : null}
        <ol>${(a.answer.citations ?? []).map(c => html`<li key=${c.index}>${c.title} · ${c.subtitle} · ${c.date}</li>`)}</ol></article>` : null}
    </section>
    ${writable ? html`<${ReadingForm} health=${a} />` : html`<p>Read-only profile</p>`}
    </div>`}
    <p role="status">${a.status}${a.statusBad ? html`<${StatusLink} host=${host} />` : null}</p><//></main></div>`;
}
