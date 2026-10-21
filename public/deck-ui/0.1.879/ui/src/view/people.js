import {PageHeader} from './page-header.js';
import {DuplicatesEntry, PeopleDuplicates, useDuplicates} from './people-duplicates.js';
import {usePageSelection} from './page-selection.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {avatarOf, createPeople} from '../people.js';
import {countText, fieldLabel, personLine} from '../format.js';
import {RowList} from './rows.js';
import {CollectionPager, CollectionSearch, useCollectionPage} from './collection-page.js';
import {PersonRecordCard} from './person-profile.js';
const html = htm.bind(h);
const PAGE_SIZE = 40;
const all = () => '';

/** People as every collection: the shared search (bridge's, over names, aliases and contacts) with the Relation filter and Show's
 *  People, Organizations (n) (bridge's `kind`, while it names any; an org shows its logo) or No photo (n) (the people with no face
 *  linked, to link one), rows that open in place (the shared record card), and the shared pager over a bounded batch. */
export function People({host, onOpen, navigation}) {
  const [model] = useState(() => createPeople(host));
  const [, redraw] = useState(0), [duplicates, showDuplicates] = useState(false), review = useDuplicates(host);
  const [selectedId, select] = usePageSelection(navigation), known = useRef(new Map());
  useEffect(() => {
    const off = model.subscribe(() => redraw(n => n + 1));
    model.refresh();
    return () => { off(); model.stop(); };
  }, [model]);
  for (const row of model.rows) known.current.set(String(row.person.id), row);
  // the server filtered already: the page only slices, and a new query or relation starts again at its first page
  const rows = model.visible(), missing = model.noPhoto();
  const list = useCollectionPage(rows, {size: PAGE_SIZE, textOf: all, resetKey: `${model.query}\n${model.relation}\n${model.kind}\n${model.photo}`});
  const search = {...list, query: model.query, setQuery: q => model.setQuery(q), count: rows.length};
  const filtered = !!(model.query.trim() || model.relation || model.kind || model.photo), orgs = model.orgs();
  return html`<main class="dk-people dk-page" aria-label="People" aria-busy=${model.loading}>
    <${PageHeader} title="People" description="Contacts, conversations and the documents that connect them."
      actions=${html`<${DuplicatesEntry} review=${review} open=${duplicates} onToggle=${showDuplicates} />`} />
    <${PeopleDuplicates} host=${host} review=${review} open=${duplicates} onClose=${() => showDuplicates(false)} onChanged=${() => model.refresh()} />
    <${CollectionSearch} always=${model.rows.length > 0 || filtered} page=${model.loading || model.error || model.warming ? {...search, total: 0} : search} label="Search people" placeholder="Names, aliases, phone or email">
      <label class="dk-collection-filter"><span>Relation</span><select class="dk-field" aria-label="Relation" value=${model.relation} onChange=${e => model.setRelation(e.currentTarget.value)}>
        <option value="">All relations</option>${model.relations().map(r => html`<option key=${r} value=${r}>${fieldLabel(r)}</option>`)}</select></label>
      <label class="dk-collection-filter"><span>Show</span><select class="dk-field" aria-label="Show" value=${model.photo === 'none' ? 'nophoto' : model.kind}
        onChange=${e => { const v = e.currentTarget.value; model.setPhoto(v === 'nophoto' ? 'none' : ''); model.setKind(v === 'nophoto' ? '' : v); }}>
        <option value="">Everyone</option>${orgs || model.kind ? html`<option value="person">People</option><option value="org">${`Organizations (${countText(orgs)})`}</option>` : null}
        <option value="nophoto">${`No photo (${countText(missing)})`}</option></select></label>
    <//>
    <${RowList} card=${true} host=${host} warming=${model.warming} loading=${model.loading && !model.rows.length ? 3 : 0}
      error=${model.error ? {error: model.error, onAction: () => model.refresh()} : null}
      empty=${model.photo && !model.query.trim() && !model.relation ? {title: 'Everyone has a photo', line: 'Every person here has a face linked.', glyph: 'person'}
        : model.kind === 'org' && !model.query.trim() && !model.relation ? {title: 'No organizations', line: 'Businesses bridge knows show here with their logo.', glyph: 'person'}
        : filtered ? {title: 'No people match', line: 'Try another name, contact detail, relation or Show.', glyph: 'find'}
        : {title: 'No people yet', line: 'Contacts show here with their conversations and documents once they are indexed.', glyph: 'person'}}
      items=${list.items.map(row => ({id: String(row.person.id), title: row.title ?? row.person.name, glyph: 'person', sub: personLine(row.person) || 'Indexed contact',
        avatar: avatarOf(row.person, row.title ?? row.person.name)}))}
      current=${selectedId} onOpen=${(r, {page} = {}) => page && navigation ? navigation.openRecord(r.id) : select(r.id)} onClose=${() => select(null)}
      expand=${r => { const row = known.current.get(String(r.id)); return row ? html`<${PersonRecordCard} key=${r.id} host=${host} item=${row} onOpen=${onOpen}
        onFull=${navigation ? () => navigation.openRecord(r.id) : null} />` : null; }} />
    <${CollectionPager} page=${list} label="People pages" />
  </main>`;
}
