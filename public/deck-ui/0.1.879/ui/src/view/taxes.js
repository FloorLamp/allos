import {PageHeader} from './page-header.js';
import {describeFailure} from '../failure.js';
import {usePageSelection} from './page-selection.js';
import {Failure} from './page-state.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {dateText} from '../format.js';
import {taxRow, missingLabel} from '../taxes.js';
import {RowList} from './rows.js';
import {Facts, Section} from './drawer.js';
import {RecordCard} from './record-card.js';
import {EntityLink} from './entity-link.js';
import {StatTiles} from './stat-tiles.js';
import {useCollectionPage, CollectionSearch, CollectionPager} from './collection-page.js';
const html = htm.bind(h);
const checklistText = item => [missingLabel(item), item.state, ...(item.documents ?? []).map(d => d.title)].join(' ');
const packetText = packet => [packet.year, packet.subtitle, ...(packet.missing ?? []).map(checklistText)].join(' ');

export function Taxes({model, host, onOpen, navigation, view}) {
  const [selected, select] = usePageSelection(navigation);
  const [, redraw] = useState(0);
  useEffect(() => model.subscribe(() => redraw(n => n + 1)), [model]);
  useEffect(() => {
    if (!navigation || model.loading) return;
    let active = true;
    queueMicrotask(() => {
      if (!active) return;
      if (!selected) { if (model.year != null) model.close(); }
      else if (/^\d{4}$/.test(selected) && model.year !== Number(selected) && model.packets.some(p => p.year === Number(selected))) model.open(Number(selected));
    });
    return () => { active = false; };
  }, [navigation, selected, model.loading, model.packets]);
  const packet = model.packet;
  const listPage = useCollectionPage(model.packets, {textOf: packetText, view, key: 'list'});
  return html`<main class="dk-taxes dk-page" aria-label="Taxes" aria-busy=${model.loading}>
    <${PageHeader} title="Taxes" description="Tax packets, checklists and documents." actions=${html`<button type="button" class="dk-btn" disabled=${model.loading} onClick=${() => model.refresh()}>Refresh</button>`} />
    <${CollectionSearch} page=${listPage} label="Search tax packets" />
    <${RowList} card=${true} host=${host} warming=${model.warming} error=${model.error ? {error: model.error, onAction: () => model.refresh()} : null} items=${listPage.items.map(taxRow)}
      current=${model.year != null ? String(model.year) : null}
      onOpen=${(r, {page} = {}) => page && navigation ? navigation.openRecord(r.id) : navigation ? select(r.id) : model.open(Number(r.id))}
      onClose=${() => navigation ? select(null) : model.close()}
      expand=${r => String(model.year) !== String(r.id) ? null
        : model.detailError ? html`<${Failure} backend="bridge" error=${model.detailError} retry=${() => model.open(model.year)} host=${host} />`
        : packet && !model.detailLoading ? html`<${TaxCard} key=${packet.year} packet=${packet} host=${host} onOpen=${onOpen} onFull=${navigation ? () => navigation.openRecord(r.id, `${packet.year} tax packet`) : null} />`
        : html`<p class="dk-note" role="status">Loading tax packet…</p>`}
      loading=${model.loading && !model.packets.length ? 3 : 0} empty=${{title: listPage.query ? 'No tax packets match' : 'No indexed tax packets'}} /><${CollectionPager} page=${listPage} label="Tax packet pages" />
  </main>`;
}
/** A checklist line: whose it is (linking to them), its kind and scope. */
const checklistTitle = (item, host) => item.person?.name
  ? html`<${EntityLink} kind="person" id=${item.person.id} label=${item.person.name} host=${host} />${missingLabel(item).slice(item.person.name.length)}` : missingLabel(item);
/** Download ZIP: the packet's authenticated export in the browser; a failure said where it was asked. */
function useExport(host, packet) {
  const [error, setError] = useState(null);
  useEffect(() => { setError(null); }, [packet?.year]);
  const run = async () => {
    setError(null);
    try { await host.call('url.open', {url: packet.export}); }
    catch (e) { setError(describeFailure('bridge', e)); }
  };
  return [run, error];
}
/** A tax packet opened in place (the shared record card): its progress and deadline, what is missing, its newest documents, the export. */
export function TaxCard({packet, host, onOpen, onFull}) {
  const [exportZip, exportError] = useExport(host, packet);
  const items = packet.items ?? [];
  const documents = [...new Map(items.flatMap(i => i.documents ?? []).map(d => [d.id, d])).values()].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
  return html`<${RecordCard} label=${`${packet.year} tax packet`} onOpen=${onFull}
    facts=${[{label: 'Present', value: `${packet.present} of ${items.length} expected`}, {label: 'Missing', value: packet.missing ? String(packet.missing) : null},
      {label: 'Deadline', value: packet.deadline ? dateText(packet.deadline) : null}]}
    groups=${[{key: 'missing', title: 'Missing · expected; verify', items: items.filter(i => i.state !== 'present').map(i => ({id: i.id, title: missingLabel(i), glyph: 'find', onOpen: onFull}))},
      {key: 'documents', title: 'Documents', items: documents.map(d => ({id: d.id, title: d.title, date: d.date, when: dateText(d.date), glyph: 'document', link: {kind: 'document', id: d.id}, onOpen: () => onOpen?.(d)}))}]}
    actions=${[packet.export ? {label: 'Download ZIP', onClick: exportZip} : null]}>
    ${exportError ? html`<${Failure} backend="bridge" error=${exportError} retry=${exportZip} host=${host} />` : null}
  <//>`;
}
/** The canonical tax packet (the whole record: Open, Find's desktop pane), including its authenticated export and spending handoff. */
export function TaxDetail({packet, model, host, onOpen, view}) {
  const [exportZip, exportError] = useExport(host, packet), [spendingError, setSpendingError] = useState(null);
  useEffect(() => { setSpendingError(null); }, [packet?.year]);
  const items = packet?.items ?? [];
  const documents = [...new Map(items.flatMap(i => i.documents).map(d => [d.id, d])).values()];
  const checklistPage = useCollectionPage(items, {textOf: checklistText, size: 20, resetKey: packet?.year, view, key: 'tax-checklist'});
  const documentPage = useCollectionPage(documents, {size: 20, resetKey: packet?.year, view, key: 'tax-documents'});
  const openSpending = async () => {
    setSpendingError(null);
    try { await host.call('url.open', {url: packet.spending.url}); }
    catch (e) { setSpendingError(describeFailure('bridge', e)); }
  };
  return html`<section class="tax-detail" aria-label="Tax packet details">
    <${StatTiles} label="Checklist progress" tiles=${[
        {key: 'present', label: 'Present', value: packet.present, sub: `of ${items.length} expected`},
        {key: 'missing', label: 'Missing', value: packet.missing},
      ]} />
    ${packet.deadline ? html`<${Facts} facts=${[{label: 'Deadline', value: dateText(packet.deadline)}]} />` : null}
    ${packet.deadlineNote ? html`<p class="dk-note">${packet.deadlineNote}</p>` : null}
    <p class="dk-note">Missing items are expectations to verify, not proof a form must be issued.</p>
    ${items.length ? html`<${Section} title="Checklist">
      <${CollectionSearch} page=${checklistPage} label="Search tax checklist" />
      <${RowList} inline=${true} items=${checklistPage.items.map(i => ({id: i.id, title: checklistTitle(i, host), tip: missingLabel(i), sub: i.state === 'present' ? 'Present' : 'Missing · expected; verify'}))} empty=${{title: checklistPage.query ? 'No checklist items match' : 'No checklist items'}} />
      <${CollectionPager} page=${checklistPage} label="Tax checklist pages" /><//>` : null}
    ${documents.length ? html`<${Section} title="Documents">
      <${CollectionSearch} page=${documentPage} label="Search tax documents" />
      <${RowList} inline=${true} items=${documentPage.items.map(d => ({id: d.id, title: d.title, sub: dateText(d.date),
        end: {label: 'Open document', onClick: () => onOpen?.(d)}}))} onOpen=${r => onOpen?.(documents.find(d => d.id === r.id))} empty=${{title: documentPage.query ? 'No documents match' : 'No indexed documents'}} />
      <${CollectionPager} page=${documentPage} label="Tax document pages" /><//>` : null}
    <${Section} title="Export and review" actions=${html`<button type="button" class="dk-btn" disabled=${!packet.export} onClick=${exportZip}>Download ZIP</button>
        ${packet.spending?.url ? html`<button type="button" class="dk-btn" onClick=${openSpending}>${packet.spending.label}</button>` : null}`}>
      <p>The authenticated export opens in your browser; sign in to Deck if asked.</p>
      ${exportError ? html`<${Failure} backend="bridge" error=${exportError} retry=${exportZip} host=${host} />` : null}
      ${packet.spending?.url ? html`<p>Household-wide spending for review, including in person-filtered packets. Sign in to Purser and select categories on the family network or VPN. This does not establish deductions or allocate spending to a person.</p>
      ${spendingError ? html`<${Failure} backend="bridge" error=${spendingError} retry=${openSpending} host=${host} />` : null}` : null}
    <//>
  </section>`;
}
