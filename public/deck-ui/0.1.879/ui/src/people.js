import {HostError, openable, resourcePath, readBridge} from './host/host.js';
import {dateText} from './format.js';
import {mergesOf} from './people-duplicates.js';
import {faceOf, subscribeFaces, withFace} from './people-faces.js';
import {cardPicks} from '../../palette/model.mjs';

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

/** Compact collection reads only. The view renders a bounded batch; selection never hydrates this list's documents. `kind`: `person`
 *  or `org` shows only people or only organisations (bridge's `person.kind`). `photo`: `none` shows only the people (never an org)
 *  without a portrait (no face linked), counted by `noPhoto()`; a face linked or unlinked on this page changes its row at once. */
export function createPeople(host, {timers = globalThis, searchDelay = 150} = {}) {
  const listeners = new Set(), knownRelations = new Set();
  let request, timer, stopped = false;
  const notify = () => { if (!stopped) for (const fn of listeners) fn(); };
  const cancel = () => { timers.clearTimeout(timer); request?.abort(); };
  const answered = answer => peopleRows(answer.results ?? []);
  // a row's portrait is as this page last changed it (personPhoto): its person's link or unlink redraws the list
  const offFaces = subscribeFaces(({id}) => { if (model.rows.some(row => String(row.person.id) === id)) notify(); });
  const model = {
    // nothing answered yet reads as loading: the page never says empty before bridge does
    rows: [], query: '', relation: '', photo: '', kind: '', loading: true, warming: false, error: null,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    relations() { return [...knownRelations].sort(); },
    /** The rows shown: every row, or only people or organisations (`kind`), and (`photo: none`) only the people without a portrait. */
    visible() {
      const kind = row => !model.kind || (model.kind === 'org') === isOrg(row.person);
      return model.rows.filter(row => kind(row) && (model.photo !== 'none' || !isOrg(row.person) && !personPhoto(row.person)));
    },
    noPhoto() { return model.rows.filter(row => !isOrg(row.person) && !personPhoto(row.person)).length; },
    /** How many organisations the answer holds (the Kind filter's). */
    orgs() { return model.rows.filter(row => isOrg(row.person)).length; },
    setKind(kind) {
      kind = ['person', 'org'].includes(kind) ? kind : '';
      if (stopped || kind === model.kind) return;
      model.kind = kind; notify();
    },
    setPhoto(photo) {
      photo = photo === 'none' ? 'none' : '';
      if (stopped || photo === model.photo) return;
      model.photo = photo; notify();
    },
    async refresh({q = model.query, relation = model.relation} = {}) {
      if (stopped) return;
      cancel();
      model.query = String(q); model.relation = String(relation);
      const current = request = new AbortController();
      model.warming = false; model.loading = true; model.error = null; notify();
      try {
        const answer = await readBridge(host, 'bridge.people', {q: model.query.trim(), relation: model.relation}, {signal: current.signal,
          snapshot: answer => { model.rows = answered(answer); notify(); },
          warming: () => { if (!current.signal.aborted) { model.warming = true; notify(); } },
        });
        if (stopped || current.signal.aborted) return;
        model.rows = answered(answer);
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
    stop() { stopped = true; cancel(); offFaces(); listeners.clear(); },
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

/** A person's portrait (view/avatar.js): bridge's `photo` only when it is this person's own `/v1/people/<id>/photo`, else null; as
 *  this page last changed it (a face linked or unlinked here: people-faces.js `withFace`). */
export function personPhoto(person = {}) {
  person = withFace(person) ?? {};
  const path = person?.id != null && !['.', '..'].includes(String(person.id)) ? `/v1/people/${encodeURIComponent(person.id)}/photo` : null;
  return path && person.photo === path && resourcePath(path, {shell: true}) ? path : null;
}

/** Whether bridge names this person a business (`kind: org`, bridge's *Organisations*): its logo instead of a face, no face picker. */
export const isOrg = person => person?.kind === 'org';

/** An org's logo (view/avatar.js): its own `/v1/people/<id>/logo` when bridge says it may have one (`logo: true`), else null. */
export function personLogo(person = {}) {
  if (!isOrg(person) || person.logo !== true || person.id == null || ['.', '..'].includes(String(person.id))) return null;
  return resourcePath(`/v1/people/${encodeURIComponent(person.id)}/logo`);
}

/** The owner's word on what someone is (`kind`: person or org), over bridge's rules (bridge.personKind: the owner's web session). */
export async function setPersonKind(host, id, kind) {
  if (host?.kind !== 'web' || !['person', 'org'].includes(kind)) throw new Error('Use the owner web session to change this.');
  return host.call('bridge.personKind', {id: String(id), kind});
}

/** What an Avatar draws for a person or an org: `{path, name, org}` (the logo for an org, else the portrait). */
export const avatarOf = (person = {}, name = person?.name) => ({path: isOrg(person) ? personLogo(person) : personPhoto(person), name, org: isOrg(person)});

/** The viewer already has this answer; reuse the same profile without fetching its person document again. */
export function normalizePersonProfile(person, item = {}) {
  person = withFace({...item.person, ...person});
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
  return {person, contacts: contactsOf(person.ids), communications, documents, links, clusters: person.clusters ?? [],
    latestCommunication: communications[0] ?? null, communicationGroups: [...groups].map(([date, items]) => ({date, items})),
    photo: personPhoto(person), face: faceOf(person), org: isOrg(person), logo: personLogo(person),
    photoLink: links.find(link => link.kind === 'immich') ?? null, merges: mergesOf(person)};
}

const BIRTH = /\b(birth(day| date)?|date of birth|born|dob)\b/i;

/** The person card's copy chips (palette SPEC.md, *Person card*): the most useful of what the find result carries, three at most —
 *  a phone, an email, the birthday — each `{label, value}` (`value` what Copy puts on the clipboard, shown as `text`). */
export function cardFacts(person = {}) {
  const contacts = contactsOf(person.ids ?? []), kind = c => c.href?.startsWith('tel:') ? 'phone' : c.href?.startsWith('mailto:') ? 'email' : BIRTH.test(c.label) ? 'birth' : 'other';
  const birth = person.birth ?? contacts.find(c => kind(c) === 'birth')?.value ?? null;
  const pick = k => contacts.find(c => kind(c) === k);
  return [pick('phone'), pick('email'), birth ? {label: 'Birthday', value: dateText(birth), glyph: 'day'} : null]
    .filter(Boolean).map(c => ({label: c.label, value: c.value, glyph: c.glyph ?? (kind(c) === 'email' ? 'mail' : 'chat')})).slice(0, 3);
}

/** The person card's few items (three at most): what the model picked for it (`row.picks`, else picked from `rows`: model `cardPicks`)
 *  as `{kind: 'event', id (its row), document (its view), title, when}` or `{kind, document, title, when}`. */
export function cardItems(row, rows = [], now = Date.now()) {
  const {event: upcoming, conversation, paper} = row.picks ?? cardPicks(row, rows, now);
  const at = (e, key) => e.allDay ? String(e[key]).slice(0, 10) : e[key];
  return [
    upcoming ? {kind: 'event', id: upcoming.id, document: upcoming.result.document ?? null, title: upcoming.result.title, when: dateText(at(upcoming.event, 'start'), {now, timeZone: upcoming.event.timeZone})} : null,
    conversation ? {kind: 'conversation', document: conversation, title: conversation.title ?? 'Conversation', when: dateText(conversation.date, {now})} : null,
    paper ? {kind: 'document', document: paper, title: paper.title ?? 'Document', when: dateText(paper.date, {now})} : null,
  ].filter(Boolean);
}
