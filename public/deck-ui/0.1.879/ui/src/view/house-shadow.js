// The Shadow reports page (contract/house.md *Admin pages*) over src/house-shadow.js: the shared header, one state while Habitat
// builds or fails the report, and one list: each rule under its heading, its line and readiness, its blockers, its unexplained runs and
// days folded; the owner's Cut over… or Roll back… under the rule, asked in place first.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {reportRows} from '../house-shadow.js';
import {PageHeader} from './page-header.js';
import {PageState} from './page-state.js';
import {RowList} from './rows.js';
const html = htm.bind(h);

/** The owner's switch for a rule, its question and its outcome: the rule row's actions. */
function Switch({model, r, title}) {
  const asking = model.confirm?.name === r.rule, busy = model.busy === r.rule, outcome = model.outcome?.name === r.rule ? model.outcome : null;
  const live = r.mode === 'live';
  return html`${asking ? html`<span class="dk-note" role="alert">${live
      ? `Roll ${title} back to shadow? Home Assistant’s automation acts again.`
      : `Cut ${title} over to live? Habitat acts and Home Assistant’s automation is turned off.`}</span>
    <button type="button" class="dk-btn main" onClick=${() => model.confirmed()}>${live ? 'Roll back' : 'Cut over'}</button>
    <button type="button" class="dk-btn" onClick=${() => model.cancel()}>Cancel</button>`
    : html`<button type="button" class="dk-btn" disabled=${busy || !!model.busy || (!live && !r.ready)} onClick=${() => model.ask(r.rule)}>
      ${busy ? 'Switching…' : live ? 'Roll back…' : 'Cut over…'}</button>`}
    ${outcome ? html`<span class=${`dk-note${outcome.bad ? ' warn' : ''}`} role="status">${outcome.text}</span>` : null}`;
}

/** The page: `model` (createShadow), `links` (the header's: the admin's own pages). */
export function HouseShadow({model, host, links = []}) {
  const [, redraw] = useState(0), [open, setOpen] = useState(() => new Set());
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  const now = model.clock(), reports = model.reports ?? [];
  const items = reports.flatMap(r => reportRows(r, {names: model.names, now, open}).map(it => it.id === r.rule && model.canSwitch ? {...it, actions: html`<${Switch} model=${model} r=${r} title=${it.title} />`} : it));
  const ready = reports.filter(r => r.mode !== 'live' && r.ready).length;
  return html`<main class="dk-page dh-shadow" aria-label="Shadow reports" aria-busy=${model.loading || model.pending}>
    <${PageHeader} title="Shadow reports" links=${links}
      description=${model.reports ? `${reports.length === 1 ? '1 ported rule' : `${reports.length} ported rules`} against Home Assistant’s automations, last 7 days${ready ? ` · ${ready} ready to cut over` : ''}.`
        : 'Each ported rule against the Home Assistant automation it replaces, last 7 days.'} />
    <${PageState} state=${model.loading || model.pending && !model.reports ? 'loading' : !reports.length ? 'empty' : 'ready'} error=${model.error} backend="habitat"
      title=${model.error ? 'Shadow reports unavailable' : 'No ported rules'} hint="Rules Habitat runs in shadow show here." retry=${() => model.refresh()} host=${host}>
      ${model.pending ? html`<p class="dk-note" role="status">Habitat is building the reports…</p>` : null}
      <${RowList} card=${true} items=${items} host=${host} onFold=${(it, on) => setOpen(s => { const next = new Set(s); if (on) next.add(it.id); else next.delete(it.id); return next; })} />
    <//>
  </main>`;
}
