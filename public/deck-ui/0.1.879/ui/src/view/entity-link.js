// Cross-links (contract/collections.md, *Cross-links*): wherever Deck names a record — a person, vehicle, property, thing, policy,
// paper, tax packet, cluster, note, document or Flightplan item — the name links to that record's page. One href rule
// (`entityHref`) and one link (`EntityLink`) for every page, card and full view. The site: plain same-origin hrefs (a middle click
// opens a new tab). A desktop: `EntityNav` (app.js) opens the record in the palette's pane, never navigating the web view. The viewer's
// People & things chips are these links too (view/viewer/side.js: `onOpen` its own way, `selected` its keyboard stop).
import {h, createContext} from '../../vendor/preact.mjs';
import {useContext, useEffect, useState} from '../../vendor/hooks.mjs';
import htm from '../../vendor/htm.mjs';
import {Glyph} from '../glyphs.js';
import {Avatar} from './avatar.js';
import {readBridge} from '../host/host.js';
import {boardPath, todoPath, siteUrl} from '../flightplan-paths.js';
const html = htm.bind(h);

/** Each kind's page: a collection's (its nav entry, contract/nav/<page>.json, `collection: true`), its glyph and what it is called.
 *  Only kinds with a live page are here (a test holds each to its nav entry), so no link leads to a page that is not there. */
export const ENTITY_KINDS = {
  person: {page: 'people', glyph: 'person', noun: 'Person'},
  vehicle: {page: 'vehicles', glyph: 'car', noun: 'Vehicle'},
  property: {page: 'properties', glyph: 'place', noun: 'Property'},
  thing: {page: 'things', glyph: 'thing', noun: 'Thing'},
  purchase: {page: 'purchases', glyph: 'receipt', noun: 'Purchase'},
  insurance: {page: 'insurance', glyph: 'umbrella', noun: 'Policy'},
  paper: {page: 'papers', glyph: 'id', noun: 'Paper'},
  tax: {page: 'taxes', glyph: 'form', noun: 'Tax packet'},
  cluster: {page: 'clusters', glyph: 'cluster', noun: 'Cluster'},
  note: {page: 'notes', glyph: 'note', noun: 'Note'},
  document: {glyph: 'document', noun: 'Document'},
  item: {glyph: 'todo', noun: 'Item'},
};
const KIND_OF = Object.fromEntries(Object.entries(ENTITY_KINDS).filter(([, k]) => k.page).map(([kind, k]) => [k.page, kind]));
/** A collection target ({collection, id}, collection-target.js) as an entity ({kind, id}), else null. */
export const entityOf = target => target && KIND_OF[target.collection] && target.id != null ? {kind: KIND_OF[target.collection], id: String(target.id)} : null;
/** An entity as a collection target, else null (a document, an item). */
export const targetOf = ({kind, id} = {}) => ENTITY_KINDS[kind]?.page && id != null ? {collection: ENTITY_KINDS[kind].page, id: String(id)} : null;

const identity = id => typeof id === 'string' ? (id.length > 0 && id.length <= 240 ? id : null) : Number.isSafeInteger(id) && id >= 0 ? String(id) : null;
const positive = id => /^[1-9]\d{0,15}$/.test(String(id ?? '')) && Number.isSafeInteger(Number(id)) ? Number(id) : null;

/** A record's page, or null when it has none (an unknown kind, no id): a collection record opened in place on its collection's page
 *  (`/<page>#<id>`; `full`: its full view, `/<page>?record=<id>#<id>`; a cluster always its own page, the full view), a document's
 *  page (`/doc/<id>`), a Flightplan item's drawer (`/todo/FP-<n>`, or the Board's `/flightplan/FP-<n>` for work in a repo). A tax
 *  packet's id is its year. */
export function entityHref(link) {
  const {kind, id, full = false, repo = null} = link ?? {};
  const k = ENTITY_KINDS[kind];
  if (!k) return null;
  if (kind === 'document') { const n = positive(id); return n ? `/doc/${n}` : null; }
  if (kind === 'item') { const n = positive(String(id ?? '').replace(/^FP-/i, '')); return n ? repo ? boardPath({id: n}) : todoPath({id: n}) : null; }
  if (kind === 'tax' && !/^\d{4}$/.test(String(id ?? ''))) return null;
  const at = identity(id);
  if (at == null) return null;
  const hash = encodeURIComponent(at);
  return full || kind === 'cluster' ? `/${k.page}?record=${hash}#${hash}` : `/${k.page}#${hash}`;
}

/** What a desktop's palette pane opens for a link (the viewer's target), or null for a page only the site has (a note, an item). */
export function entityTarget(link) {
  const {kind, id} = link ?? {};
  if (!entityHref({kind, id})) return null;
  if (kind === 'document') return {id: positive(id), query: ''};
  const page = ENTITY_KINDS[kind].page;
  if (!page || kind === 'note') return null;
  return {collection: {collection: page, id: identity(id)}, query: ''};
}

/** A desktop's navigation ({open(link), host}): every link click (any button) opens there instead of following the href. */
export const EntityNav = createContext(null);
/** Inside Find's selected record (record-card.js `CardStops`): a link is one of the card's Tab stops, out of the page's order. */
export const LinkStops = createContext(false);

// A person bridge's people projection does not hold (the owner's own record) has no People page: its link would land on
// "unavailable". Which people have one comes from one read of the projection per host, shared by every link on the page.
const peopleKnown = new WeakMap();
function knownPeople(host) {
  if (!host?.call) return Promise.resolve(null);
  let known = peopleKnown.get(host);
  if (!known) {
    known = readBridge(host, 'bridge.people', {q: '', relation: ''})
      .then(answer => new Set((answer?.results ?? []).map(r => r.person?.id).filter(id => id != null).map(String)), () => null);
    peopleKnown.set(host, known);
  }
  return known;
}
/** Whether a link may show now (its href, else null): a person's once the projection is known to hold them; any other kind with a page
 *  at once. */
export function useLinkable(link, host) {
  const href = entityHref(link), person = link?.kind === 'person' && !!href;
  const [people, setPeople] = useState(null);
  useEffect(() => {
    if (!person) return undefined;
    let live = true;
    knownPeople(host).then(set => { if (live) setPeople(set); });
    return () => { live = false; };
  }, [person, host]);
  if (!href) return null;
  if (person && !people?.has(String(link.id))) return null;
  return href;
}

/** Follow a link the way this host does (rows and other controls that are not anchors): the desktop's pane, else the page. */
export function useEntityOpen() {
  const nav = useContext(EntityNav);
  return link => {
    const href = entityHref(link);
    if (!href) return;
    if (nav) nav.open(link, href);
    else globalThis.location?.assign(href);
  };
}

/** A record's name as a link to its page: `{kind, id}` (entityHref's), `label` (its name; text or nodes), `chip` (a chip with the kind's
 *  glyph), `full` (its full view), `onOpen(link)` (a plain click does this instead, e.g. a document in the page's own viewer; a
 *  modified or middle click still opens the href; with `pages: false`, a host with no pages, every click is onOpen's), `host` (for a
 *  person: whether People holds them; `known`: the caller already read them from bridge's collections), `title` its tooltip,
 *  `selected` a keyboard's stop (the viewer's side), `avatar` ({path, name}: a person's portrait in a chip's glyph place, view/avatar.js).
 *  No page: the label alone. */
export function EntityLink({kind, id, label, chip = false, full = false, repo = null, onOpen = null, pages = true, known = false, host = null,
  title = null, selected = false, avatar = null, class: cls = null, stops: own = false}) {
  const nav = useContext(EntityNav), inCard = useContext(LinkStops);
  const link = {kind, id, full, repo};
  const checked = useLinkable(known ? null : link, host ?? nav?.host);
  const href = known ? entityHref(link) : checked;
  const text = label ?? ENTITY_KINDS[kind]?.noun ?? '';
  if (!href) return chip ? html`<span class=${`dk-chip dk-entity-chip quiet${cls ? ` ${cls}` : ''}`}><${Glyph} name=${ENTITY_KINDS[kind]?.glyph ?? 'document'} size=${12} /><span>${text}</span></span>`
    : html`<span class=${cls}>${text}</span>`;
  const plain = ev => ev.button === 0 && !ev.ctrlKey && !ev.metaKey && !ev.shiftKey && !ev.altKey;
  const follow = ev => {
    ev.stopPropagation();
    if (onOpen && (!pages || ev.type === 'click' && plain(ev))) { ev.preventDefault(); onOpen(link); return; }
    if (nav) { ev.preventDefault(); nav.open(link, href); return; }
  };
  const stops = inCard || own;
  return html`<a class=${`${chip ? 'dk-chip dk-entity-chip' : 'dk-entity'}${selected ? ' sel' : ''}${cls ? ` ${cls}` : ''}`} href=${nav ? siteUrl(href) : href} data-entity=${kind}
    title=${title ?? (typeof text === 'string' ? `${ENTITY_KINDS[kind].noun}: ${text}` : null)} onClick=${follow} onAuxClick=${nav || !pages ? follow : ev => ev.stopPropagation()}
    ...${stops ? {tabindex: '-1', 'data-stop': ''} : {}}>${chip ? html`${avatar ? html`<${Avatar} host=${host ?? nav?.host} path=${avatar.path} name=${avatar.name} class="dk-entity-avatar" />`
      : html`<${Glyph} name=${ENTITY_KINDS[kind].glyph} size=${12} />`}<span>${text}</span>` : text}</a>`;
}

/** A link to one of the site's own pages that is no record (House admin's rule, Money's transaction): `path` on the site; a desktop
 *  (no pages of its own) opens it on the site through the host. */
export function SiteLink({host, path, label}) {
  const web = host?.kind === 'web', href = web ? path : `https://deck.wang.team${path}`;
  return html`<a class="dk-entity" href=${href} title=${label} onClick=${ev => {
    if (web) return;
    ev.preventDefault();
    host?.call('url.open', {url: href}).catch(() => {});
  }}><span>${label}</span></a>`;
}
