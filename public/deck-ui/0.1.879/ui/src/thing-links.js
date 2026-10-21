// A thing's links (contract/things.md *Links*), no DOM: what bridge joins to one physical thing (a purchase, a House device or entity,
// a house record, documents, a vehicle), each by the owner or by a rule with its evidence, bridge's suggestions, and the writes: link,
// move (an exclusive target another thing has, asked first), unlink and Not it. Bridge owns every join; Deck never guesses one.
import {describeFailure} from './failure.js';
import {memberCan} from './host/member.js';
import {recordHref} from './collection-target.js';

/** Each kind in the order a thing lists them, with its group's name and glyph; `pick`: the Link… picker offers it. */
export const LINK_KINDS = [
  {kind: 'purchase', label: 'Purchases', one: 'Purchase', glyph: 'order', pick: true},
  {kind: 'device', label: 'House devices', one: 'House device', glyph: 'plug', pick: true},
  {kind: 'entity', label: 'Entities', one: 'Entity', glyph: 'toggle', pick: true},
  {kind: 'record', label: 'House records', one: 'House record', glyph: 'house', pick: true},
  {kind: 'document', label: 'Documents', one: 'Document', glyph: 'document', pick: true},
  {kind: 'vehicle', label: 'Vehicles', one: 'Vehicle', glyph: 'car', pick: false},
];
const THING = {kind: 'thing', label: 'Things', one: 'Thing', glyph: 'thing'};
/** A kind's names and glyph (LINK_KINDS', or `thing`: the picker's things). */
export const kindOf = kind => LINK_KINDS.find(k => k.kind === kind) ?? (kind === 'thing' ? THING : {kind, label: kind, one: kind, glyph: 'link'});
/** One thing at most per target, but documents (a manual serves several things). */
export const exclusive = kind => kind !== 'document';
/** May this page's member link and unlink (member.js: the agent member reads only; an unknown member may, the backend decides)? */
export const canLink = host => memberCan(host?.member, 'write');
export const linkKey = l => `${l.kind}:${l.id}`;

/** Links grouped by kind, in LINK_KINDS' order, the empty kinds left out. */
export const groupLinks = (links = []) => LINK_KINDS.map(k => ({...k, links: links.filter(l => l.kind === k.kind)})).filter(g => g.links.length);
/** Who made a link, said quietly: by hand, or a rule and what it matched on. */
export const byText = l => l.by === 'owner' ? 'Linked by hand' : l.evidence ? `Found by rule: ${l.evidence}` : 'Found by rule';

/** The thing an exclusive target belongs to now when that is another thing than `thingId` (a search result's `thing`, a
 *  suggestion's `linkedTo`), else null: linking it there is a move, asked first. */
export function ownerElsewhere(target, thingId) {
  const owner = target?.linkedTo ?? target?.thing ?? null;
  return owner && exclusive(target.kind) && String(owner.id).toLowerCase() !== String(thingId ?? '').toLowerCase() ? owner : null;
}

/** Bridge's search for a picker: `kind` one of LINK_KINDS' or `thing`; an empty `q` its first `limit` (newest purchases, all records…). */
export async function searchTargets(host, {kind, q = '', limit = 20}, {signal} = {}) {
  const answer = await host.call('bridge.things.search', {query: {kind, ...(q.trim() ? {q: q.trim()} : {}), limit}}, {signal});
  return Array.isArray(answer?.results) ? answer.results : [];
}

/** Links `target` ({kind, id}) to the thing `thing` (its UUID); `move` takes an exclusive target from the thing that has it. */
export const linkTarget = (host, thing, {kind, id}, {move = false} = {}) =>
  host.call('bridge.things.link', {query: {thing}, body: {kind, id, ...(move ? {move: true} : {})}});
/** A new thing named `name` (and what else is known: make, model, kind, room, notes, aliases), `from` ({kind, id}: a purchase line,
 *  a House device or entity) linked to it by the owner at once. Empty fields are not sent. */
export function createThing(host, {name, from, move = false, ...fields}) {
  const known = Object.fromEntries(['make', 'model', 'kind', 'room', 'notes'].map(k => [k, String(fields[k] ?? '').trim()]).filter(([, v]) => v));
  return host.call('bridge.things.create', {body: {name: String(name).trim(), ...known, ...(fields.aliases?.length ? {aliases: fields.aliases} : {}),
    ...(from ? {from: {kind: from.kind, id: from.id}} : {}), ...(move ? {move: true} : {})}});
}
/** A thing's other names (bridge's `aliases`): replaced whole, bridge trims and dedupes. */
export const saveAliases = (host, thing, aliases) => host.call('bridge.things.aliases', {query: {thing}, body: {aliases}});
export const MAX_ALIASES = 20, MAX_ALIAS = 80;
/** Aliases as typed (commas or lines between them): trimmed, the same name once (case aside); `error` past bridge's bounds. */
export function parseAliases(text) {
  const seen = new Set(), aliases = [];
  for (const a of String(text ?? '').split(/[,\n]/).map(x => x.trim()).filter(Boolean))
    if (!seen.has(a.toLowerCase())) { seen.add(a.toLowerCase()); aliases.push(a); }
  const error = aliases.length > MAX_ALIASES ? `At most ${MAX_ALIASES} names` : aliases.some(a => a.length > MAX_ALIAS) ? `Each name at most ${MAX_ALIAS} characters` : null;
  return {aliases, error};
}
/** A thing's whole record on the site (its full view over Things: contract/collections.md). */
export const thingPage = id => recordHref({collection: 'things', id});
/** What a House tile links: its entity's device (Habitat's `device`, `ha:<id>`), else the entity itself. */
export const houseTarget = e => e.device ? {kind: 'device', id: e.device, title: e.name} : {kind: 'entity', id: e.id, title: e.name};
/** Bridge's 409: the target is another thing's (its `linkedTo` when the host passes bridge's answer through, else unknown). */
export const isConflict = e => e?.status === 409;

export function createThingLinks(host) {
  let generation = 0, stopped = false, request;
  const subscribers = new Set();
  const changed = () => { for (const fn of subscribers) fn(); };
  const apply = answer => {
    model.links = Array.isArray(answer?.links) ? answer.links : [];
    model.suggestions = Array.isArray(answer?.suggestions) ? answer.suggestions : [];
    model.unavailable = Array.isArray(answer?.unavailable) ? answer.unavailable : [];
  };
  const say = (text, bad = false) => { model.outcome = {text, bad}; };
  async function write(key, run, done) {
    if (stopped || model.busy.has(key)) return false;
    const thing = model.id;
    model.busy.add(key); model.outcome = null; changed();
    let ok = false;
    try {
      const answer = await run();
      if (!stopped && thing === model.id) { apply(answer); done?.(); ok = true; }
    } catch (e) {
      if (!stopped && thing === model.id) {
        if (isConflict(e) && model.pending) model.confirm = {...model.pending, linkedTo: e.linkedTo ?? null};
        else say(describeFailure('bridge', e).message, true);
      }
    }
    model.busy.delete(key); model.pending = null;
    if (!stopped) changed();
    return ok;
  }
  const model = {
    id: null, links: [], suggestions: [], unavailable: [], loading: false, error: null, busy: new Set(),
    /** A move waiting for the owner's yes: {target, linkedTo: {id, name} | null}. */
    confirm: null, pending: null, outcome: null, writable: canLink(host),
    subscribe(fn) { subscribers.add(fn); return () => subscribers.delete(fn); },
    async open(id) {
      if (stopped) return;
      request?.abort(); request = new AbortController();
      const current = ++generation;
      if (model.id !== id) { apply(null); model.confirm = null; model.outcome = null; }
      model.id = id; model.loading = true; model.error = null; changed();
      try {
        const answer = await host.call('bridge.things.links', {query: {thing: id}}, {signal: request.signal});
        if (!stopped && current === generation) apply(answer);
      } catch (e) {
        if (!stopped && current === generation) { apply(null); model.error = describeFailure('bridge', e); }
      }
      if (!stopped && current === generation) { model.loading = false; changed(); }
    },
    /** Links a picked or suggested target; one another thing has is asked first (`confirm`), never moved silently. */
    link(target) {
      if (!model.writable) return Promise.resolve(false);
      const owner = ownerElsewhere(target, model.id);
      if (owner) { model.confirm = {target, linkedTo: owner}; model.outcome = null; changed(); return Promise.resolve(false); }
      return model.write(target, false);
    },
    write(target, move) {
      model.pending = {target};
      return write(linkKey(target), () => linkTarget(host, model.id, target, {move}), () => say(`Linked ${target.title ?? kindOf(target.kind).one.toLowerCase()}`));
    },
    /** The asked move: yes. */
    move() {
      const c = model.confirm;
      if (!c) return Promise.resolve(false);
      model.confirm = null;
      return model.write(c.target, true);
    },
    cancel() { if (model.confirm) { model.confirm = null; changed(); } },
    /** Unlinks a link, or says Not it to a suggestion (the same DELETE: bridge's rule never adds or suggests that pair again). */
    unlink(link, {notIt = false} = {}) {
      if (!model.writable) return Promise.resolve(false);
      return write(linkKey(link), () => host.call('bridge.things.unlink', {query: {thing: model.id, kind: link.kind, id: String(link.id)}}),
        () => say(notIt ? `Not it: ${link.title}` : `Unlinked ${link.title}`));
    },
    stop() { stopped = true; generation++; request?.abort(); subscribers.clear(); },
  };
  return model;
}
