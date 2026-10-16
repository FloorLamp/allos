import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';
import {RowList} from './rows.js';
import {CollectionDetails} from './collection-details.js';

export function People({host, onOpen}) {
  const [results, setResults] = useState([]), [relation, setRelation] = useState('');
  const [relations, setRelations] = useState([]), [selected, select] = useState(null);
  const [loading, setLoading] = useState(true), [error, setError] = useState(null);
  useEffect(() => {
    const request = new AbortController();
    setLoading(true); setError(null);
    host.call('bridge.people', {q: '', relation}, {signal: request.signal}).then(answer => {
      if (request.signal.aborted) return;
      setResults(answer.results ?? []);
      setRelations(previous => [...new Set([...previous, ...(answer.results ?? []).map(r => r.person?.relation).filter(Boolean)])].sort());
      setLoading(false);
    }, error => { if (!request.signal.aborted) { setError(error); setLoading(false); } });
    return () => request.abort();
  }, [host, relation]);
  return h('main', {class: 'dk-people', 'aria-label': 'People'},
    h('h1', {}, 'People'),
    h('label', {}, 'Relation ', h('select', {class: 'dk-field', value: relation, onChange: e => setRelation(e.currentTarget.value)},
      h('option', {value: ''}, 'All relations'), relations.map(r => h('option', {key: r, value: r}, r)))),
    h(RowList, {items: results.map(r => ({...r, id: r.person.id, title: r.title ?? r.person.name,
      sub: [r.person.relation, `${r.person.documentCount ?? 0} documents`, r.person.organisation, r.person.lastContact].filter(Boolean).join(' · '), end: {label: 'Details', onClick: () => select(r)}})),
      loading: loading ? 3 : 0, error, empty: {title: 'No indexed people'}, onOpen: row => onOpen?.(row.document)}),
    h(CollectionDetails, {host, item: selected, onClose: () => select(null), onOpen}));
}
