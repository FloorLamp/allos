import {HostError, openable, resourcePath, readBridge} from './host/host.js';

const filled = (first, next) => Object.fromEntries([...new Set([...Object.keys(first), ...Object.keys(next)])]
  .map(key => [key, first[key] == null || first[key] === '' ? next[key] : first[key]]));

/** Registry/view identities prove duplicates; a shared name, household phone or organisation does not. */
export function peopleRows(results = []) {
  const groups = [], identities = new Map();
  for (const row of results) {
    if (!row?.person) continue;
    const keys = [row.person.id != null ? `person:${row.person.id}` : null,
      row.document?.id != null ? `document:${row.document.id}` : null].filter(Boolean);
    const matches = [...new Set(keys.map(key => identities.get(key)).filter(Boolean))];
    const group = matches[0] ?? {row, keys: new Set(), removed: false};
    if (!matches.length) groups.push(group);
    for (const other of [...matches.slice(1), {row, keys: new Set()}]) {
      const a = group.row.person, b = other.row.person;
      group.row = {...filled(group.row, other.row), person: {...filled(a, b),
        documentCount: Math.max(a.documentCount ?? 0, b.documentCount ?? 0),
        lastContact: [a.lastContact, b.lastContact].filter(Boolean).sort().at(-1) ?? null}};
      for (const key of other.keys) { group.keys.add(key); identities.set(key, group); }
      if (matches.includes(other)) other.removed = true;
    }
    for (const key of keys) { group.keys.add(key); identities.set(key, group); }
  }
  return groups.filter(group => !group.removed).map(group => group.row);
}

/** Compact collection reads only. The view renders a bounded batch; selection never hydrates this list's documents. */
export function createPeople(host, {timers = globalThis, searchDelay = 150} = {}) {
  const listeners = new Set(), knownRelations = new Set();
  let request, timer, stopped = false;
  const notify = () => { if (!stopped) for (const fn of listeners) fn(); };
  const cancel = () => { timers.clearTimeout(timer); request?.abort(); };
  const model = {
    rows: [], query: '', relation: '', loading: false, warming: false, error: null,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    relations() { return [...knownRelations].sort(); },
    async refresh({q = model.query, relation = model.relation} = {}) {
      if (stopped) return;
      cancel();
      model.query = String(q); model.relation = String(relation);
      const current = request = new AbortController();
      model.warming = false; model.loading = true; model.error = null; notify();
      try {
        const answer = await readBridge(host, 'bridge.people', {q: model.query.trim(), relation: model.relation}, {signal: current.signal,
          snapshot: answer => { model.rows = peopleRows(answer.results ?? []); notify(); },
          warming: () => { if (!current.signal.aborted) { model.warming = true; notify(); } },
        });
        if (stopped || current.signal.aborted) return;
        model.rows = peopleRows(answer.results ?? []);
        for (const row of model.rows) if (row.person.relation) knownRelations.add(row.person.relation);
      } catch (error) { if (!stopped && !current.signal.aborted) model.error = error; }
      finally { if (!stopped && !current.signal.aborted) { model.warming = false; model.loading = false; notify(); } }
    },
    setQuery(query) {
      query = String(query);
      if (stopped || query === model.query) return;
      cancel(); model.query = query; model.warming = false; model.loading = true; model.error = null; notify();
      timer = timers.setTimeout(() => model.refresh(), searchDelay);
    },
    setRelation(relation) {
      relation = String(relation);
      if (stopped || relation === model.relation) return;
      model.relation = relation;
      return model.refresh();
    },
    stop() { stopped = true; cancel(); listeners.clear(); },
  };
  return model;
}

const documentsOf = documents => {
  const byId = new Map();
  for (const doc of documents) {
    if (doc?.id == null) continue;
    const key = String(doc.id);
    byId.set(key, byId.has(key) ? filled(byId.get(key), doc) : doc);
  }
  return [...byId.values()].sort((a, b) => String(b.date ?? '').localeCompare(String(a.date ?? '')));
};

/** Contact addresses are copied exactly; normalization is only for duplicate detection and explicit call/mail destinations. */
function contactsOf(ids = []) {
  const contacts = new Map();
  for (const id of ids) {
    const value = String(id?.value ?? '').trim();
    if (!value) continue;
    const label = id.title || 'Contact';
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    const phone = (/\b(phone|mobile|cell|telephone|tel|fax)\b/i.test(label) || value.startsWith('+')) && /\d/.test(value)
      && /^\+?[\d\s().-]+(?:\s*(?:ext\.?|x)\s*\d+)?$/i.test(value);
    const normalized = email ? value.toLowerCase() : phone ? value.toLowerCase().replace(/(?:ext\.?|x)\s*(\d+)$/, 'x$1').replace(/[\s().+-]/g, '') : value;
    const key = `${email ? 'email' : phone ? 'phone' : label}:${normalized}`;
    if (contacts.has(key)) continue;
    const href = email ? `mailto:${encodeURIComponent(value)}` : phone
      ? `tel:${value.trim().startsWith('+') ? '+' : ''}${normalized.replace(/x(\d+)$/, ';ext=$1')}` : null;
    contacts.set(key, {label, value, ...(href ? {href} : {})});
  }
  return [...contacts.values()];
}

/** One person-view read supplies contacts and dated membership, including 5,000+ documents; no per-document requests. */
export async function personProfile(host, row, signal) {
  if (signal?.aborted) throw new HostError('cancelled');
  const document = row.document ?? row.result?.document;
  if (document?.id == null) throw new HostError('http', 'Person details unavailable', 404);
  const answer = await host.call('bridge.pages', {id: document.id}, {signal});
  if (signal?.aborted) throw new HostError('cancelled');
  if (!answer?.person) throw new HostError('http', 'Person details unavailable', 404);
  return normalizePersonProfile(answer.person, row);
}

/** The viewer already has this answer; reuse the same profile without fetching its person document again. */
export function normalizePersonProfile(person, item = {}) {
  person = {...item.person, ...person};
  const conversations = documentsOf(person.conversations ?? []), mails = documentsOf(person.mails ?? []);
  const communicationKind = new Map([...mails.map(doc => [String(doc.id), 'email']), ...conversations.map(doc => [String(doc.id), 'text'])]);
  const communications = documentsOf([...conversations, ...mails]).map(document => ({document, title: document.title ?? '',
    date: document.date ?? null, kind: communicationKind.get(String(document.id))}));
  const documents = documentsOf([...conversations, ...mails, ...(person.papers ?? []), ...(person.documents ?? [])]);
  const groups = new Map();
  for (const item of communications) {
    const date = item.date?.slice(0, 10) ?? null;
    if (!groups.has(date)) groups.set(date, []);
    groups.get(date).push(item);
  }
  const links = (person.links ?? []).filter(link => openable(link.url));
  const photoPath = person.id != null && !['.', '..'].includes(String(person.id)) ? `/v1/people/${encodeURIComponent(person.id)}/photo` : null;
  return {person, contacts: contactsOf(person.ids), communications, documents, links, clusters: person.clusters ?? [],
    latestCommunication: communications[0] ?? null, communicationGroups: [...groups].map(([date, items]) => ({date, items})),
    photo: photoPath && person.photo === photoPath && resourcePath(photoPath, {shell: true}) ? photoPath : null,
    photoLink: links.find(link => link.kind === 'immich') ?? null};
}
