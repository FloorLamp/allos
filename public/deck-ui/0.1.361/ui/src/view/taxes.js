import {describeFailure} from '../failure.js';
import {Failure} from './failure.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {createTaxes, taxRow, missingLabel} from '../taxes.js';
import {RowList} from './rows.js';
import {Drawer} from './drawer.js';
import {StatTiles} from './stat-tiles.js';
const html = htm.bind(h);

export function Taxes({model, host, onOpen}) {
  const [, redraw] = useState(0), [exportError, setExportError] = useState(null), [spendingError, setSpendingError] = useState(null);
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  useEffect(() => { setExportError(null); setSpendingError(null); }, [model.year]);
  const packet = model.packet, items = packet?.items ?? [];
  const documents = [...new Map(items.flatMap(i => i.documents).map(d => [d.id, d])).values()];
  const exportZip = async () => {
    setExportError(null);
    try { await host.call('url.open', {url: packet.export}); }
    catch (e) { setExportError(describeFailure('bridge', e)); }
  };
  const openSpending = async () => {
    setSpendingError(null);
    try { await host.call('url.open', {url: packet.spending.url}); }
    catch (e) { setSpendingError(describeFailure('bridge', e)); }
  };
  return html`<main class="dk-taxes" aria-label="Taxes" aria-busy=${model.loading}>
    <header><h1>Taxes</h1><button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => model.refresh()}>Refresh</button></header>
    ${model.error ? html`<${Failure} backend="bridge" error=${model.error} retry=${() => model.refresh()} host=${host} />` : null}
    ${!model.error ? html`<${RowList} items=${model.packets.map(p => ({...taxRow(p), end: {label: 'Open tax packet', onClick: () => model.open(p.year)}}))}
      onOpen=${r => model.open(Number(r.id))} loading=${model.loading ? 3 : 0} empty=${{title: 'No indexed tax packets'}} />` : null}
    <${Drawer} open=${model.year != null} title=${`${model.year} tax packet`} onClose=${() => model.close()}>
      ${model.detailLoading ? html`<p role="status">Loading tax packet…</p>` : null}
      ${model.detailError ? html`<${Failure} backend="bridge" error=${model.detailError} retry=${() => model.open(model.year)} host=${host} />` : null}
      ${packet ? html`<${StatTiles} label="Checklist progress" tiles=${[
        {key: 'present', label: 'Present', value: packet.present},
        {key: 'missing', label: 'Missing', value: packet.missing},
        {key: 'total', label: 'Total', value: items.length},
      ]} />
      <p>Missing items are expectations to verify, not proof a form must be issued.</p>
      <h2>Checklist</h2>
      <${RowList} items=${items.map(i => ({id: i.id, title: missingLabel(i), sub: i.state === 'present' ? 'Present' : 'Missing · expected; verify'}))} empty=${{title: 'No checklist items'}} />
      <h2>Documents</h2>
      <${RowList} items=${documents.map(d => ({id: d.id, title: d.title, sub: d.date,
        end: {label: 'Open document', onClick: () => onOpen?.(d)}}))} onOpen=${r => onOpen?.(documents.find(d => d.id === r.id))} empty=${{title: 'No indexed documents'}} />
      <button type="button" class="dk-btn" disabled=${!packet.export} onClick=${exportZip}>Download ZIP</button>
      <p>The authenticated export opens in your browser; sign in to Deck if asked.</p>
      ${exportError ? html`<${Failure} backend="bridge" error=${exportError} retry=${exportZip} host=${host} />` : null}
      ${packet.spending?.url ? html`<button type="button" class="dk-btn" onClick=${openSpending}>${packet.spending.label}</button>
      <p>Household-wide spending for review, including in person-filtered packets. Sign in to Purser and select categories on the family network or VPN. This does not establish deductions or allocate spending to a person.</p>
      ${spendingError ? html`<${Failure} backend="bridge" error=${spendingError} retry=${openSpending} host=${host} />` : null}` : null}
      <p>${packet.deadline} · ${packet.deadlineNote}</p>` : null}
    <//>
  </main>`;
}
export function TaxesPlace({host, onOpen}) {
  const [model] = useState(() => createTaxes(host));
  useEffect(() => { model.refresh(); return () => model.stop(); }, [model]);
  return html`<${Taxes} model=${model} host=${host} onOpen=${onOpen} />`;
}
