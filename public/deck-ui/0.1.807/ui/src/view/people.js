import {PageHeader} from './page-header.js';
import {PeopleDuplicates, DuplicatesToggle} from './people-duplicates.js';
import {usePageSelection} from './page-selection.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {createPeople} from '../people.js';
import {fieldLabel, personLine} from '../format.js';
import {RowList} from './rows.js';
import {CollectionPager, CollectionSearch, useCollectionPage} from './collection-page.js';
import {PersonProfile} from './person-profile.js';
const html = htm.bind(h);
const PAGE_SIZE = 40;
const all = () => '';

/** People as every collection: the shared search (bridge's, over names, aliases and contacts) with the Relation filter, rows that open
 *  the shared detail drawer, and the shared pager over a bounded batch. */
export function People({host, onOpen, navigation}) {
  const [model] = useState(() => createPeople(host));
  const [, redraw] = useState(0), [duplicates, showDuplicates] = useState(false);
  const [selectedId, select] = usePageSelection(navigation), known = useRef(new Map());
  useEffect(() => {
    const off = model.subscribe(() => redraw(n => n + 1));
    model.refresh();
    return () => { off(); model.stop(); };
  }, [model]);
  for (const row of model.rows) known.current.set(String(row.person.id), row);
  // the server filtered already: the page only slices, and a new query or relation starts again at its first page
  const list = useCollectionPage(model.rows, {size: PAGE_SIZE, textOf: all, resetKey: `${model.query}\n${model.relation}`});
  const search = {...list, query: model.query, setQuery: q => model.setQuery(q), count: model.rows.length};
  const filtered = !!(model.query.trim() || model.relation);
  const selected = selectedId == null ? null : known.current.get(String(selectedId));
  return html`<main class="dk-people dk-page" aria-label="People" aria-busy=${model.loading}>
    <${PageHeader} title="People" description="Contacts, conversations and the documents that connect them."
      actions=${html`<${DuplicatesToggle} open=${duplicates} onToggle=${showDuplicates} />`} />
    <${PeopleDuplicates} host=${host} open=${duplicates} onResolved=${() => model.refresh()} />
    <${CollectionSearch} always=${model.rows.length > 0 || filtered} page=${model.loading || model.error || model.warming ? {...search, total: 0} : search} label="Search people" placeholder="Names, aliases, phone or email">
      <label class="dk-collection-filter"><span>Relation</span><select class="dk-field" aria-label="Relation" value=${model.relation} onChange=${e => model.setRelation(e.currentTarget.value)}>
        <option value="">All relations</option>${model.relations().map(r => html`<option key=${r} value=${r}>${fieldLabel(r)}</option>`)}</select></label>
    <//>
    <${RowList} card=${true} host=${host} warming=${model.warming} loading=${model.loading && !model.rows.length ? 3 : 0}
      error=${model.error ? {error: model.error, onAction: () => model.refresh()} : null}
      empty=${filtered ? {title: 'No people match', line: 'Try another name, contact detail or relation.', glyph: 'find'}
        : {title: 'No people yet', line: 'Contacts show here with their conversations and documents once they are indexed.', glyph: 'person'}}
      items=${list.items.map(row => ({id: String(row.person.id), title: row.title ?? row.person.name, glyph: 'person', sub: personLine(row.person) || 'Indexed contact'}))}
      current=${selectedId} onOpen=${r => select(r.id)} />
    <${CollectionPager} page=${list} label="People pages" />
    <${PersonProfile} host=${host} item=${selected} onClose=${() => select(null)} onOpen=${onOpen} />
  </main>`;
}
