// The Zigbee reconnect page (contract/house.md *Admin pages*) over src/house-zigbee.js: the shared header with how many are
// offline and whether joining is open, the owner's permit-join, every device by area (offline first, what to do for each) and the
// activity feed, one state while the first snapshot comes or fails.
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {deviceRows, feedRows, joinOptions, summaryLine} from '../house-zigbee.js';
import {timeText} from '../format.js';
import {PageHeader} from './page-header.js';
import {PageState} from './page-state.js';
import {RowList} from './rows.js';
const html = htm.bind(h);

/** The owner's permit-join: through which router, Allow joining (60 s), Stop, what came of it. */
function Join({model}) {
  return html`<section class="dh-zigbee-join" aria-label="Allow joining">
    <label class="dk-collection-filter"><span>Join through</span><select class="dk-field" aria-label="Join through" value=${model.via}
      onChange=${ev => model.choose(ev.currentTarget.value)}>${joinOptions(model.snapshot).map(o => html`<option key=${o.value} value=${o.value}>${o.label}</option>`)}</select></label>
    <button type="button" class="dk-btn main" disabled=${model.busy} onClick=${() => model.permit(true)}>Allow joining (60 s)</button>
    <button type="button" class="dk-btn" disabled=${model.busy} onClick=${() => model.permit(false)}>Stop</button>
    ${model.note ? html`<span class=${`dk-note${model.note.bad ? ' warn' : ''}`} role="status">${model.note.text}</span>` : null}
  </section>`;
}

/** The page: `model` (createZigbee), `links` (the header's). */
export function HouseZigbee({model, host, links = []}) {
  const [, redraw] = useState(0);
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  // joining open: its seconds left count down
  const open = !!model.snapshot?.permit_join;
  useEffect(() => { if (!open) return undefined; const t = setInterval(() => redraw(n => n + 1), 1000); return () => clearInterval(t); }, [open]);
  const now = model.clock(), s = model.snapshot;
  const line = s ? [summaryLine(s, {now}), model.connected ? `Updated ${timeText(model.updated)}` : 'Reconnecting…'].join(' · ') : 'Every Zigbee device by room, offline first, and how to bring one back.';
  return html`<main class="dk-page dh-zigbee" aria-label="Zigbee reconnect" aria-busy=${model.loading}>
    <${PageHeader} title="Zigbee reconnect" description=${line} links=${links} />
    <${PageState} state=${model.loading ? 'loading' : !s?.devices?.length ? 'empty' : 'ready'} error=${model.error} backend="habitat"
      title=${model.error ? 'Zigbee unavailable' : 'No Zigbee devices'} hint="Devices paired with Zigbee2MQTT show here." retry=${() => model.start()} host=${host}>
      ${model.owner ? html`<${Join} model=${model} />` : null}
      <section aria-label="Devices"><${RowList} card=${true} items=${deviceRows(s, {now})} host=${host} /></section>
      <section aria-label="Activity"><h2 class="dk-label">Activity</h2>
        <${RowList} card=${true} inline=${true} items=${feedRows(s, {now})} host=${host} empty=${{title: 'Nothing yet'}} /></section>
    <//>
  </main>`;
}
