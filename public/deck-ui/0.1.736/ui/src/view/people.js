import {PageHeader} from './page-header.js';
import {PeopleDuplicates} from './people-duplicates.js';
import {usePageSelection} from './page-selection.js';
import {h} from '../../vendor/preact.mjs';
import {useEffect, useRef, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {createPeople} from '../people.js';
import {dateLabel} from '../../../palette/model.mjs';
import {PageState} from './page-state.js';
import {PersonProfile, PersonAvatar, relationLabel} from './person-profile.js';
const html = htm.bind(h);
const PAGE_SIZE = 40;

export function People({host, onOpen, navigation}) {
  const [model] = useState(() => createPeople(host));
  const [, redraw] = useState(0), [page, setPage] = useState(0);
  const [selectedId, select] = usePageSelection(navigation), known = useRef(new Map());
  useEffect(() => {
    const off = model.subscribe(() => redraw(n => n + 1));
    model.refresh();
    return () => { off(); model.stop(); };
  }, [model]);
  useEffect(() => setPage(0), [model.query, model.relation]);
  for (const row of model.rows) known.current.set(String(row.person.id), row);
  const total = model.rows.length, lastPage = Math.max(0, Math.ceil(total / PAGE_SIZE) - 1), currentPage = Math.min(page, lastPage);
  const start = currentPage * PAGE_SIZE, rows = model.rows.slice(start, start + PAGE_SIZE);
  const selected = selectedId == null ? null : known.current.get(String(selectedId));
  const turn = next => { setPage(next); document.querySelector('.people-results-heading')?.scrollIntoView({block: 'nearest'}); };
  return html`<main class="dk-people dk-page" aria-label="People" aria-busy=${model.loading}>
    <${PageHeader} title="People" description="Contacts, conversations and the documents that connect them." />
    <${PeopleDuplicates} host=${host} onResolved=${() => model.refresh()} />
    <form class="people-search" role="search" onSubmit=${e => e.preventDefault()}>
      <label class="people-query"><span>Find a person</span><input class="dk-field" type="search" autocomplete="off" value=${model.query}
        aria-label="Find a person" placeholder="Search names, aliases or contact details" onInput=${e => model.setQuery(e.currentTarget.value)} /></label>
      <label class="people-relation"><span>Relation</span><select class="dk-field" aria-label="Relation" value=${model.relation} onChange=${e => model.setRelation(e.currentTarget.value)}>
        <option value="">All relations</option>${model.relations().map(r => html`<option key=${r} value=${r}>${relationLabel(r)}</option>`)}</select></label>
    </form>
    <div class="people-results-heading"><h2>${model.query.trim() ? 'Search results' : 'Your people'}</h2><p role="status">${model.loading ? 'Finding people…' : `${total.toLocaleString()} ${total === 1 ? 'person' : 'people'}${total ? ` · ${start + 1}–${Math.min(start + PAGE_SIZE, total)}` : ''}`}</p></div>
    <${PageState} state=${model.warming ? 'warming' : model.loading && !rows.length ? 'loading' : !rows.length ? 'empty' : undefined}
      error=${model.error} host=${host} retry=${() => model.refresh()}
      hint=${model.query || model.relation ? 'No people match. Try another name or relation.' : 'No indexed people yet.'}>
      <ul class="people-list">${rows.map(row => {
        const p = row.person, name = row.title ?? p.name;
        return html`<li key=${p.id}><button type="button" class="person-row dp-row" data-person-id=${p.id} aria-label=${`Open profile: ${name}`} onClick=${() => select(p.id)}>
          <${PersonAvatar} name=${name} />
          <span class="person-row-lines"><span class="person-row-name">${name}</span><span class="person-row-context">${[relationLabel(p.relation), p.organisation ?? p.vendor, p.role].filter(Boolean).join(' · ') || 'Indexed contact'}</span>
            <span class="person-row-history">${p.lastContact ? `Last contact ${dateLabel(p.lastContact)}` : 'Last contact not recorded'}${p.documentCount != null ? ` · ${p.documentCount.toLocaleString()} documents` : ''}</span></span>
          <span class="person-row-open" aria-hidden="true">View profile ›</span>
        </button></li>`;
      })}</ul>
      ${total > PAGE_SIZE ? html`<nav class="people-paging" aria-label="People pages"><button type="button" class="dk-btn" disabled=${currentPage === 0} onClick=${() => turn(currentPage - 1)}>Previous people</button><span>Page ${currentPage + 1} of ${lastPage + 1}</span><button type="button" class="dk-btn" disabled=${currentPage === lastPage} onClick=${() => turn(currentPage + 1)}>Next people</button></nav>` : null}
    <//>
    <${PersonProfile} host=${host} item=${selected} onClose=${() => select(null)} onOpen=${onOpen} />
  </main>`;
}
