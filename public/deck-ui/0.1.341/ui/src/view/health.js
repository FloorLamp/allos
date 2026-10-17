import {Failure, StatusLink} from './failure.js';
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
  }}><h2>Log a reading</h2><div class="dh-fields">${READING.map(([key, label]) => html`<label key=${key}>${label}<input class="dk-field" name=${key} type="number" step="any" /></label>`)}</div>
  <button class="dk-btn" disabled=${health.busy || health.loading}>Save reading</button></form>`;
}
export function Health({health: a, host, opts = {}}) {
  const [q, setQ] = useState('');
  const shell = opts.nav ? html`<${ShellBar} nav=${opts.nav} current="health" />` : null;
  if (!a.owner) return html`<div>${shell}${a.loading ? html`<main class="dhealth" aria-busy="true"><h1>Health</h1><p role="status">Loading health…</p>
    ${['Today’s doses', 'Recent readings', 'Labs'].map(title => html`<section key=${title}><h2>${title}</h2><div class="dh-skeleton" aria-hidden="true"></div></section>`)}</main>` : html`<${Failure} backend="allos" error=${a.error ?? (host.backends?.includes('allos') ? {status: 403} : {code: 'not-set-up'})} retry=${() => a.refresh()} host=${host} />`}</div>`;
  const writable = a.profiles?.find(p => p.id === a.profile)?.access === 'write';
  const open = r => opts.onRecord?.({key: r.key, title: r.title, profile: a.profile});
  return html`<div class="dh-page">
    ${shell}
    <main class="dhealth" aria-busy=${a.loading}><header><h1>Health</h1><label>Profile <select aria-label="Profile" disabled=${a.loading || a.busy} value=${a.profile} onChange=${ev => a.refresh(a.profiles.find(p => String(p.id) === ev.target.value)?.id)}>
      ${(a.profiles ?? []).map(p => html`<option key=${p.id} value=${p.id}>${p.name ?? p.label}</option>`)}</select></label>
      <button class="dk-btn" disabled=${a.loading || a.busy} onClick=${() => a.refresh()}>${a.loading ? 'Refreshing…' : 'Refresh'}</button></header>
    ${a.error ? html`<${Failure} backend="allos" error=${a.error} retry=${() => a.refresh()} host=${host} />` : null}
    <section><h2>Today’s doses</h2><p>${a.board?.day} ${a.board?.allDone ? '· All done' : ''}</p>
      ${!a.board?.meds?.length ? html`<p>No scheduled doses</p>` : a.board.meds.map(m => html`<div key=${m.id}><h3>${m.name}</h3>
        ${m.doses.map(d => html`<div class="dh-dose" key=${d.id}><span>${d.label} · ${d.timeOfDay}${d.pastDue && !d.status ? ' · Past due' : ''}</span>
          <span>${d.status ?? 'Due'}</span>${writable ? html`<button class="dk-btn" disabled=${a.busy || a.loading} onClick=${() => a.dose(d.id, 'take')}>Take</button>
          <button class="dk-btn" disabled=${a.busy || a.loading} onClick=${() => a.dose(d.id, 'skip')}>Skip</button>${d.status ? html`<button class="dk-btn" disabled=${a.busy || a.loading} onClick=${() => a.dose(d.id, 'clear')}>Undo</button>` : null}` : null}</div>`)}</div>`)}
    </section>
    <div class="dh-columns"><section><h2>Recent readings</h2>${a.readings.length ? a.readings.map((r, i) => html`<p key=${i}><b>${r.kind.replaceAll('_', ' ')}</b> · ${r.value ?? `${r.systolic}/${r.diastolic}`} ${r.unit}<small>${r.date} ${r.freshness ?? ''}</small></p>`) : html`<p>No readings</p>`}</section>
    <section><h2>Labs</h2>${a.labs.length ? a.labs.map((l, i) => html`<p key=${i}><b>${l.name}</b> · ${l.value} ${l.unit} · ${l.flag}<small>${l.date} ${l.freshness ?? ''}</small></p>`) : html`<p>No labs</p>`}</section></div>
    <section><h2>Records</h2><form onSubmit=${ev => { ev.preventDefault(); a.search(q); }}><label>Find or ask about records<input class="dk-field" type="search" value=${q} onInput=${ev => setQ(ev.target.value)} /></label>
      <button class="dk-btn" disabled=${a.loading || !q.trim()}>Find records</button> <button class="dk-btn" type="button" disabled=${a.loading || !q.trim()} onClick=${() => a.search(q, true)}>Ask records</button></form>
      ${a.results.map(r => html`<button key=${r.key} class="dh-result dk-btn" disabled=${a.loading} onClick=${() => open(r)}>${r.title} · ${r.subtitle} · ${r.date}</button>`)}
      ${a.answer ? html`<article aria-label="Record answer"><p>${a.answer.answer}</p>${a.answer.offline ? html`<${Failure} backend="allos" error=${{code: 'unreachable'}} retry=${() => a.search(q, true)} host=${host} />` : null}
        <ol>${(a.answer.citations ?? []).map(c => html`<li key=${c.index}>${c.title} · ${c.subtitle} · ${c.date}</li>`)}</ol></article>` : null}
    </section>
    ${writable ? html`<${ReadingForm} health=${a} />` : html`<p>Read-only profile</p>`}
    <p role="status">${a.status}${a.statusBad ? html`<${StatusLink} host=${host} />` : null}</p></main></div>`;
}
