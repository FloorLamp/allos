// The viewer's state (palette SPEC.md, *Viewer* and *Related*; DESIGN.md §3 P1), no DOM: what it shows (a bridge document, an
// attachment or archive entry of one, a message's attachment, a Recent item), its history, the Related rail per document, the
// header's actions as host ops (CONTRACT.md), telemetry without content. The views (view/viewer/*.js) render it and tell it what they
// need (the first page drawn, older messages); npm test drives it with the fake host.
import {hasFile, relatedRail, sourceName} from '../../palette/model.mjs';
import {hostError, openable, resourcePath} from './host/host.js';
import {createDetails} from './details.js';
import {healthIdentity, healthKey} from './health.js';

/** Kinds this viewer shows (bridge CONTRACT.md, *Pages*); any other (`none`, one added later) opens the document's page instead. */
export const KINDS = ['pages', 'text', 'table', 'video', 'archive', 'conversation', 'email', 'thing', 'person', 'trip', 'event', 'day'];
/** Kinds that are bridge's view of several documents (a person, a trip), not a document read: no Details. */
export const VIEWS = ['person', 'trip', 'event', 'day'];
/** What an attachment or archive entry may be to open here (its own `pages` answer says the rest). */
export const OPENS = ['pages', 'text', 'table', 'video', 'archive'];
/** bridge's page widths: a device-pixel width snapped up to 800, 1600 or 2400. */
export const snap = px => px <= 800 ? 800 : px <= 1600 ? 1600 : 2400;
/** Attachments open two levels deep at most (a zip within a mail); deeper ones open at the source. */
export const MAX_DEPTH = 2;

/** A video being prepared: bridge's Retry-After when it gave one (30 s at most), else 1 s for its first 10 s, 2 s to a minute, then 5. */
export function retryDelay(elapsedMs, retryAfter) {
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.min(retryAfter, 30) * 1000;
  return elapsedMs < 10_000 ? 1000 : elapsedMs < 60_000 ? 2000 : 5000;
}

/** A Texts conversation's entry id (`texts:<conversation>`: bridge's `/v1/texts/<conversation>`), else null. */
export const textsOf = id => typeof id === 'string' && id.startsWith('texts:') && id.length > 6 ? id.slice(6) : null;
/** Where an entry is: `/v1/doc/<id>[/message/<m>][/attachment/<a>[/attachment/<e>]]`, a Texts conversation's `/v1/texts/<conversation>/…`. */
export const basePath = e => `${e.texts != null ? `/v1/texts/${encodeURIComponent(e.texts)}` : `/v1/doc/${e.id}`}${e.message != null ? `/message/${encodeURIComponent(e.message)}` : ''}${e.attachments.map(n => `/attachment/${n}`).join('')}`;
/** Page n of an entry at width w (its answer's version pinning the cache). */
export const pagePath = (e, n, w) => `${basePath(e)}/page/${n}?w=${w}${e.answer?.version ? `&v=${encodeURIComponent(e.answer.version)}` : ''}`;

const plural = (n, one, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;
const duration = s => { const t = Math.round(s), h = Math.floor(t / 3600), m = Math.floor(t / 60) % 60, x = String(t % 60).padStart(2, '0'); return h ? `${h}:${String(m).padStart(2, '0')}:${x}` : `${m}:${x}`; };
const FROM = {docx: 'Document', doc: 'Document', odt: 'Document', rtf: 'Document', pptx: 'Slides', ppt: 'Slides', odp: 'Slides', xls: 'Spreadsheet', ods: 'Spreadsheet'};

/** The header's meta line (SPEC.md, *Viewer*): `PDF · page 2 of 3`, `Photo`, `Mail · 2 attachments`, `Spreadsheet · 240 rows`,
 *  `Video · 3:12`, `Archive · 12 files`, `Texts · Sam Rivera`, `Mail · 4 messages · 2 attachments`, `Device · Primary Bath`,
 *  `Person · plumber`, `Trip · 31 Jul–5 Aug 2021`. `ui`: the page in view, the
 *  sheet shown. */
export function meta(e, ui = {}) {
  if (!e) return '';
  if (e.status === 'loading') return 'Loading…';
  if (e.status === 'failed') return 'Couldn’t load';
  if (e.status === 'none') return 'No preview';
  const a = e.answer ?? {};
  switch (e.kind) {
    case 'pages':
      if (a.of === 'image') return e.recent ? 'Image' : 'Photo';
      return [FROM[a.from] ?? (a.from ? String(a.from).toUpperCase() : 'PDF'), `page ${ui.page ?? 1} of ${a.pages?.length ?? a.count ?? 1}`].join(' · ');
    case 'text': {
      const n = a.attachments?.length ?? 0, mail = /mail/i.test(e.document?.type ?? '') || e.document?.source === 'gmail';
      return [e.recent ? 'Text' : mail ? 'Mail' : 'Text', n ? plural(n, 'attachment') : null].filter(Boolean).join(' · ');
    }
    case 'table': {
      const sheets = a.sheets ?? [], s = sheets[ui.sheet ?? 0];
      return ['Spreadsheet', s ? plural(Math.max(s.rowCount ?? 0, s.rows?.length ?? 0), 'row') : null, sheets.length > 1 ? plural(sheets.length, 'sheet') : null].filter(Boolean).join(' · ');
    }
    case 'video': return ['Video', a.duration ? duration(a.duration) : null].filter(Boolean).join(' · ');
    case 'archive': return `Archive · ${plural(Math.max(a.total ?? 0, a.entries?.length ?? 0), 'file')}`;
    case 'conversation': return [e.document?.source === 'signal' ? 'Signal' : 'Texts', (a.participants ?? []).filter(p => !p.me).map(p => p.name).join(', ') || null].filter(Boolean).join(' · ');
    case 'email': {
      const ms = (a.messages ?? []).filter(m => !m.hidden), n = ms.reduce((t, m) => t + (m.attachments?.length ?? 0), 0);
      return ['Mail', plural(ms.length, 'message'), n ? plural(n, 'attachment') : null].filter(Boolean).join(' · ');
    }
    case 'file': return ['File', e.recent?.size ? size(e.recent.size) : null].filter(Boolean).join(' · ');
    case 'person': { const p = a.person ?? {}; return ['Person', p.role ?? p.vendor].filter(Boolean).join(' · '); }
    case 'event': return ['Event', a.event?.calendar].filter(Boolean).join(' · ');
    case 'day': return 'Day';
    case 'trip': { const t = a.trip ?? {}; return ['Trip', String(t.line ?? '').split(' · ')[0] || null].filter(Boolean).join(' · '); }
    case 'thing': {
      const t = a.thing ?? {};
      return t.type === 'plant' ? ['Plant', (t.areas ?? [])[0]].filter(Boolean).join(' · ') : ['Device', t.room?.name ?? t.location].filter(Boolean).join(' · ');
    }
  }
  return '';
}

/** Bytes as people read them: `482 KB`, `1.8 MB`. */
export const size = n => !n ? '' : n >= 1e9 ? `${(n / 1e9).toFixed(1)} GB` : n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`;

/** "Open in Seafile" (SPEC.md: `Open source` when bridge names none). */
export const openIn = source => sourceName(source) ? `Open in ${sourceName(source)}` : 'Open source';
export const sourceLabel = e => e.kind === 'event' && e.answer?.event?.link ? 'Open Calendar' : openIn(e.source);

/** The viewer's hint line (SPEC.md, *Viewer*: ≤ 4): Esc Back or Close, N Next match when matching (else a video's Space, a table's or
 *  conversation's Find), Enter Details (`details`: it has them, not shown), else R Related, Mod+Enter Open in <source>; with the
 *  rail's selection: Esc Leave, Enter Open, Tab Show all. */
export function hint(e, {railAt = -1, matches = 0, rail = false, embedded = false, details = false, detailsShown = false} = {}) {
  if (!e) return [];
  const out = [];
  if (railAt >= 0) out.push(['Esc', 'Leave'], ['Enter', 'Open'], ['Tab', 'Show all']);
  else {
    if (e.parent || !embedded) out.push(['Esc', e.parent ? 'Back' : 'Close']);
    if (matches > 1) out.push(['N', 'Next match']);
    else if (e.kind === 'video') out.push(['Space', 'Play']);
    else if (e.kind === 'table' || e.kind === 'conversation') out.push(['Mod+F', 'Find']);
    if (details && !detailsShown) out.push(['Enter', 'Details']);
    else if (rail) out.push(['R', 'Related']);
  }
  if (e.id != null) out.push(['Mod+Enter', sourceLabel(e)]);
  return out.slice(0, 4);
}

/** One `/v1/doc/…/message/<m>/inline/<part>` or `/v1/doc/<id>/image?u=` path of an email's html, as its attribute holds it. */
const unescape = s => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');
/** The image paths an email's messages name: `data-inline-src` (shown at once) or `data-remote-src` (after Load images). */
export function imagePaths(messages, remote = false) {
  const re = remote ? /data-remote-src="([^"]+)"/g : /data-inline-src="([^"]+)"/g, out = new Set();
  for (const m of messages ?? []) for (const [, p] of String(m.html ?? '').matchAll(re)) if (resourcePath(unescape(p))) out.add(unescape(p));
  return [...out].slice(0, 100);
}

/** An image's type by its first bytes: JPEG, PNG, GIF, WebP, BMP; anything else (an SVG, a page) is no image here. */
export function sniff(b) {
  if (b.length > 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg';
  if (b.length > 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return 'image/png';
  if (b.length > 6 && b[0] === 0x47 && b[1] === 0x49 && b[2] === 0x46) return 'image/gif';
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[8] === 0x57 && b[9] === 0x45) return 'image/webp';
  if (b.length > 2 && b[0] === 0x42 && b[1] === 0x4d) return 'image/bmp';
  return null;
}
const dataUrl = (bytes, type) => { let s = ''; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000)); return `data:${type};base64,${btoa(s)}`; };

/** A local day `YYYY-MM-DD` of an ISO time. */
export const dayOf = at => { const d = new Date(at); return Number.isNaN(d.getTime()) ? '' : `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** opts: `embedded` (the site's document page: no close, a kind it cannot show stays as a state block), `onClose` (Esc on the first
 *  document), `onGroup(key, title)` (a Related chip or `All n ›`: the palette opens the group; none: a chip opens the map, `All n`
 *  shows every item in the rail), `details` (false: no Details pane, the page shows its own), `fetch` (resources' bytes: Recent
 *  text, email images), `now`, `timers`. */
export function createViewer(host, {embedded = false, onClose = () => {}, onGroup = null, details = true, fetch: get = globalThis.fetch?.bind(globalThis), now = () => Date.now(), timers = globalThis} = {}) {
  const listeners = new Set(), work = new Set();
  let seq = 0, noteTimer = null;
  const v = {
    host, embedded,
    /** The document shown (its `parent` the one it opened from), else null. */
    entry: null,
    /** Related per document id: {busy, error, none, rail, more: {kind: true}}. */
    related: {},
    /** The rail shown (R; prefs `rail`, per device). */
    railShown: true,
    /** The Details pane shown in the rail's place (I; prefs `details`, per device). */
    detailsShown: false,
    /** Details per document id (details.js), loaded when first shown. */
    details: {},
    /** A word in the header for a moment (`Copied`). */
    note: null,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    async start() {
      const [r, dt] = await Promise.all(['rail', 'details'].map(key => host.call('prefs.get', {key}).catch(() => null)));
      if (typeof r?.value === 'boolean') v.railShown = r.value;
      if (typeof dt?.value === 'boolean') v.detailsShown = dt.value;
      changed();
    },

    /** Open a bridge document ({id, query, document?}) or a Recent item ({recent: item or id}): a new history. */
    open(target) {
      if (v.entry) leave(v.entry);
      return track(load(target?.recent != null ? recentEntry(target.recent) : docEntry(target), true));
    },
    /** A Related item: the viewer re-targets to it (history; the rail follows). */
    openRelated(item) {
      const d = item.document;
      return push(docEntry({id: d.id, query: '', document: d}), true);
    },
    /** An attachment (a text's, an email message's or a conversation message's: `message`) or an archive entry: here (history) when
     *  its kind shows here and it is not too deep; otherwise the document's page. */
    openAttachment(a, message = null) {
      const p = v.entry;
      if (!p || p.id == null) return Promise.resolve();
      const attachments = message != null ? [a.n] : [...p.attachments, a.n];
      if (!OPENS.includes(a.kind) || a.unavailable || attachments.length > MAX_DEPTH) return v.source();
      return push({...blank(), id: p.id, texts: p.texts, message: message ?? p.message, attachments, title: String(a.name ?? 'Attachment').split('/').pop(), source: p.source, url: p.url, query: p.query,
        document: p.document, file: false}, false);
    },
    /** Back: the document this one opened from, else close (the rows, the selection kept). */
    back() {
      const e = v.entry;
      if (!e) return;
      if (!e.parent) return v.close();
      leave(e);
      v.entry = e.parent;
      if (v.entry.status === 'loading') track(load(v.entry, false));
      changed();
    },
    close() {
      if (embedded && v.entry && !v.entry.parent) return;
      if (v.entry) leave(v.entry);
      v.entry = null;
      changed();
      onClose();
    },
    /** A fresh viewer (the host's `hide`). */
    reset() { if (v.entry) leave(v.entry); v.entry = null; v.related = {}; v.details = {}; changed(); },
    /** What it shows, as plain data for Deck's own window to open on (window.popOut's `state`): the history to the entry shown, each
     *  entry what it is and where it was (`view`: the page, zoom, scroll, sheet, filter, the mails open); never bridge's answers (the
     *  window asks again, from the shell's cache). Null when closed. */
    snapshot() {
      const chain = [];
      for (let e = v.entry; e; e = e.parent) {
        chain.unshift({id: e.id, message: e.message, attachments: e.attachments, title: e.title, source: e.source, url: e.url, file: e.file, query: e.query,
          health: e.health, document: e.document, recent: e.recent, view: e.view});
      }
      return chain.length ? {chain} : null;
    },
    /** A snapshot back: its history, the entry shown loaded where it was (no `view` telemetry: nobody opened it here); the ones before
     *  it load when Back reaches them. False when it holds nothing to show. */
    restore(s) {
      if (v.entry) leave(v.entry);
      let parent = null;
      for (const x of Array.isArray(s?.chain) ? s.chain.slice(-20) : []) {
        if (!x || typeof x !== 'object') continue;
        const e = x.recent != null ? recentEntry(x.recent) : docEntry({id: x.id, health: x.health, query: x.query, document: x.document && typeof x.document === 'object' ? x.document : null, title: x.title});
        if (!e.health && !e.recent && e.texts == null && !(Number.isInteger(e.id) && e.id > 0)) continue;
        Object.assign(e, {message: typeof x.message === 'string' || Number.isInteger(x.message) ? x.message : null, attachments: Array.isArray(x.attachments) ? x.attachments.filter(Number.isInteger).slice(0, MAX_DEPTH) : [],
          view: x.view && typeof x.view === 'object' ? {...x.view} : {}, parent});
        if (!e.recent) Object.assign(e, {source: x.source ?? e.source, url: openable(x.url ?? null) ?? e.url, file: typeof x.file === 'boolean' ? x.file : e.file});
        parent = e;
      }
      if (!parent) { v.entry = null; changed(); return false; }
      track(load(parent, false));
      return true;
    },
    retry() { const e = v.entry; if (e && (e.status === 'failed' || e.status === 'loading')) return track(load(e, false)); return Promise.resolve(); },

    /** The source button, Mod+Enter: the document's page (its `url`, else the host's own); a Texts conversation's in Google Messages. */
    source() {
      const e = v.entry;
      if (!e || e.id == null) return Promise.resolve();
      if (e.answer?.kind === 'event' && e.answer.event?.link) return v.openUrl(e.answer.event.link);
      return outside(page(e, openable(e.answer?.url ?? e.url ?? null)));
    },
    /** Whether Open file shows: a bridge document with an original (model hasFile), a Recent file. */
    hasFile(e = v.entry) { return !!e && (e.recent ? e.recent.kind === 'file' && !!host.caps.recent : e.attachments.length === 0 && e.message == null && hasFile(e.document ?? {source: e.source, file: e.file})); },
    openFile() {
      const e = v.entry;
      if (!v.hasFile(e) || e.status === 'loading') return Promise.resolve();
      return outside(e.recent ? host.call('recent.open', {id: e.recent.id}) : host.call('document.open', {id: e.id}));
    },
    /** Copy text (a text's, a sheet's or the selected cells as TSV). */
    copy(text) {
      if (!host.caps.clipboard || !text) return Promise.resolve();
      return act(host.call('clipboard.copy', {text: String(text).slice(0, 100000), sensitive: false}).then(() => say('Copied')));
    },
    toggleRail() {
      v.railShown = !v.railShown;
      host.call('prefs.set', {key: 'rail', value: v.railShown}).catch(() => {});
      changed();
    },
    /** Details (I): what was read from the document, and its corrections; it takes the rail's place while shown. */
    toggleDetails() {
      v.detailsShown = !v.detailsShown;
      host.call('prefs.set', {key: 'details', value: v.detailsShown}).catch(() => {});
      changed();
    },
    /** Whether this entry has Details: a bridge document itself (not an attachment, a message's, or Recent; not a person's or a trip's
     *  view, source `bridge`: nothing was read from it), unless the page shows its own. */
    hasDetails(e = v.entry) { return details && !!e && e.id != null && e.texts == null && !e.recent && e.message == null && e.attachments.length === 0 && e.source !== 'bridge' && !VIEWS.includes(e.kind); },
    /** The Details pane's state of this entry's document (details.js), asked of bridge the first time. */
    detailsFor(e = v.entry) {
      if (!v.hasDetails(e)) return null;
      if (!v.details[e.id]) {
        // a corrected title or type shows in the header too
        const onChange = doc => {
          for (let x = v.entry; x; x = x.parent) {
            if (x.id !== doc?.id || x.attachments.length || x.message != null) continue;
            x.title = doc.title || x.title;
            if (x.document) x.document = {...x.document, title: doc.title, type: doc.type, date: doc.date};
          }
          changed();
        };
        const d = v.details[e.id] = createDetails(host, {now, timers, onChange});
        track(d.load(e.id));
      }
      return v.details[e.id];
    },
    /** Whether this entry has a rail: a bridge document itself (not an attachment, not Recent) Related did not 404. */
    hasRail(e = v.entry) { return !!e && e.id != null && e.texts == null && !e.recent && e.message == null && e.attachments.length === 0 && !v.related[e.id]?.none; },
    railFor(e = v.entry) { return e ? v.related[e.id] ?? null : null; },
    retryRelated() { const e = v.entry; if (e?.id != null) track(loadRelated(e.id, true)); },

    /** A Related chip: the group in the palette; Mod (`map`) or no palette: bridge's map. */
    chip(chip, {map = false} = {}) {
      const at = chip.key.indexOf(':'), by = chip.key.slice(0, at), value = chip.key.slice(at + 1);
      if (onGroup && !map) return onGroup(chip.key, chip.label);
      return outside(host.call('map.open', {by, value}));
    },
    /** `All n ›`: the group in the palette; without one, every item of the kind in the rail. */
    allOf(group) {
      if (onGroup) return onGroup(group.key, group.label);
      const e = v.entry;
      if (e?.id == null) return;
      return track(moreOf(e.id, group.kind));
    },
    /** A Related item's page (Mod+Enter, Mod+click). */
    itemPage(item) { return outside(host.call('document.page', {id: item.document.id, url: openable(item.document.url ?? null)})); },
    /** A link (an email's): the browser. */
    openUrl(url) { const u = openable(url); return u ? outside(host.call('url.open', {url: u})) : Promise.resolve(); },

    /** A view drew the first page (or failed it): the `view` telemetry's time (once per open). */
    firstPage(e, ok = true) {
      if (!e.reported) { e.reported = true; telemetry('view', ok, e.opened); }
      if (e === v.entry && !e.relatedAsked) askRelated(e);
    },

    /** A conversation's next messages by its cursor (`older`: before), merged in order; answers how many arrived. */
    async moreMessages(older) {
      const e = v.entry, a = e?.answer;
      if (e?.kind !== 'conversation') return 0;
      const dir = older ? 'before' : 'after', cursor = a[dir];
      if (!cursor || e.paging[dir]) return 0;
      e.paging[dir] = true;
      changed();
      try {
        const r = await (e.texts != null ? host.call('bridge.textsConversation', {conv: e.texts, cursor: String(cursor), dir})
          : host.call('bridge.conversation', {id: e.id, cursor: String(cursor), dir}));
        if (v.entry !== e) return 0;
        const have = new Set(a.messages.map(m => m.id)), got = (r?.messages ?? []).filter(m => !have.has(m.id));
        e.answer = {...a, messages: older ? [...got, ...a.messages] : [...a.messages, ...got], [dir]: r?.[dir] ?? null};
        return got.length;
      } catch (err) {
        e.pagingError = failure(err);
        return 0;
      } finally {
        e.paging[dir] = false;
        changed();
      }
    },
    /** Find in a conversation past what is loaded: bridge's `pages?q=` anchors on the best day's hit; the conversation reopens there.
     *  Answers the anchor's id (null: no hit; a Texts conversation has no day to anchor on: its loaded messages only). */
    async anchorOn(q) {
      const e = v.entry;
      if (e?.kind !== 'conversation' || e.texts != null || !q.trim()) return null;
      try {
        const r = await pages(e, {q: q.trim().slice(0, 300)});
        if (v.entry !== e || r?.kind !== 'conversation') return null;
        e.answer = r;
        changed();
        return r.anchor ?? null;
      } catch { return null; }
    },
    /** Mod+G: the first message on or after a day (`YYYY-MM-DD`), loading older or newer pages until it is among them (20 at most). */
    async jumpTo(day) {
      const e = v.entry;
      if (e?.kind !== 'conversation' || !/^\d{4}-\d{2}-\d{2}$/.test(day)) return null;
      for (let i = 0; i < 20 && e.answer.before && dayOf(e.answer.messages[0]?.at) > day; i++) if (!await v.moreMessages(true)) break;
      for (let i = 0; i < 20 && e.answer.after && !(dayOf(e.answer.messages.at(-1)?.at) >= day); i++) if (!await v.moreMessages(false)) break;
      const ms = e.answer.messages.filter(m => m.at);
      return (ms.find(m => dayOf(m.at) >= day) ?? ms.at(-1))?.id ?? null;
    },

    /** An email's image as a data URL by its path, once fetched (inline at once, remote after Load images). */
    image(path) { return v.entry?.images?.get(unescape(path)) ?? null; },
    /** Load images: the thread's remote images through bridge's image proxy, for this thread only. */
    loadImages() {
      const e = v.entry;
      if (e?.kind !== 'email' || e.remote) return Promise.resolve();
      e.remote = true;
      changed();
      return track(images(e, true));
    },

    /** Settles once nothing it started is still running. */
    async idle() { while (work.size) await Promise.allSettled([...work]); },
  };

  function changed() { for (const fn of listeners) fn(v); }
  function track(p) { if (!p) return Promise.resolve(); work.add(p); p.finally(() => work.delete(p)); return p; }
  const failure = e => { const h = hostError(e); return {code: h.code, ...(h.status ? {status: h.status} : {}), message: h.message}; };
  // `view` (from the open, the Enter or Space that asked for it, to its first page) and `related` are the UI's on every host with
  // telemetry (P2: a shell's prefetch is never a view)
  const telemetry = (name, ok, t0, detail) => {
    if (!host.caps.telemetry) return;
    host.call('telemetry.event', {name, ok, ms: Math.max(0, Math.round(now() - t0)), ...(detail ? {detail} : {})}).catch(() => {});
  };
  function act(p) { return track(p.then(() => null, err => { say(failure(err).message); })); }
  /** Something opened outside (a page, a file, the map, a link): a shell's panel hides so it shows (window.hide `opened`). */
  function outside(p) { return act(p.then(() => host.caps.window ? host.call('window.hide', {reason: 'opened'}) : null)); }
  function say(text) {
    v.note = text;
    changed();
    timers.clearTimeout(noteTimer);
    noteTimer = timers.setTimeout(() => { v.note = null; changed(); }, 1600);
  }

  function blank() {
    return {seq: ++seq, id: null, message: null, attachments: [], title: '', source: null, url: null, file: false, query: '', document: null, recent: null,
      status: 'loading', kind: null, answer: null, error: null, parent: null, view: {}, paging: {}, opened: now(), reported: false, relatedAsked: false, abort: null};
  }
  function docEntry({id, health = null, query = '', document = null, title = null}) {
    const d = document ?? {}, texts = textsOf(id);
    health = health ?? d.health ?? (healthKey(id) != null ? {key: healthKey(id)} : null);
    return {...blank(), id: health ? null : texts != null ? id : Number(id), health, healthTitle: health ? title ?? d.title : null, texts, query: String(query ?? '').trim(), document: document ?? null, title: health ? 'Health' : title ?? d.title ?? '', source: d.source ?? null,
      url: openable(d.url ?? null), file: hasFile(d)};
  }
  function recentEntry(item) {
    const it = typeof item === 'object' ? item : {id: String(item)};
    const image = it.kind === 'image' || /^image\//.test(it.type ?? '') || /\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(it.name ?? '');
    return {...blank(), recent: it, title: it.name || (image ? 'Image' : it.kind === 'file' ? 'File' : 'Text'), image};
  }
  function leave(e) { e.abort?.abort(); }
  function push(e, report) {
    const from = v.entry;
    if (from) { leave(from); e.parent = from; }
    return track(load(e, report));
  }
  const pagesArgs = e => ({id: e.id, ...(e.message != null ? {message: String(e.message)} : {}), ...(e.attachments.length ? {attachments: e.attachments} : {})});
  /** bridge's `pages` of an entry (`extra`: its `q`); a Texts conversation's through its own op (no `q`: it opens at its newest). */
  const pages = (e, extra = {}, opts) => e.texts == null ? host.call('bridge.pages', {...pagesArgs(e), ...extra}, opts)
    : host.call('bridge.textsPages', {conv: e.texts, ...(e.message != null ? {message: String(e.message)} : {}), ...(e.attachments.length ? {attachments: e.attachments} : {})}, opts);
  /** An entry's page outside: a document's (document.page), a Texts conversation's own link (no bridge page of it). */
  const page = (e, url) => e.texts == null ? host.call('document.page', {id: e.id, url}) : url ? host.call('url.open', {url}) : Promise.resolve();

  /** An entry shown: its kind from bridge's `pages` (or a Recent item's bytes), `view` telemetry once per open. */
  async function load(e, report) {
    v.entry = e;
    e.status = 'loading'; e.error = null; e.opened = now(); e.reported = !report;
    const abort = e.abort = new AbortController();
    changed();
    if (e.health) {
      e.answer = null;
      try {
        if (!await healthIdentity(host)) throw new Error('Health is unavailable');
        const r = await host.call('allos.record', {query: {key: e.health.key, ...(e.health.profile != null ? {profile: e.health.profile} : {})}}, {signal: abort.signal});
        if (v.entry !== e || abort.signal.aborted) return;
        e.title = e.healthTitle || r.record?.title || r.record?.name || r.kind;
        e.source = 'allos'; e.kind = 'text'; e.status = 'ready';
        e.answer = {kind: 'text', text: Object.entries(r.record ?? {}).filter(([, value]) => value != null && ['string', 'number', 'boolean'].includes(typeof value)).map(([key, value]) => `${key.replaceAll('_', ' ')}: ${value}`).join('\n\n')};
      } catch (err) { if (v.entry !== e || abort.signal.aborted) return; e.title = 'Health'; e.status = 'failed'; e.error = failure(err); }
      changed();
      return;
    }
    if (e.recent) return loadRecent(e);
    if (!e.title && !e.parent && e.texts == null) host.call('bridge.doc', {id: e.id}).then(d => {
      if (!d) return;
      Object.assign(e, {title: e.title || d.title || '', source: e.source ?? d.source ?? null, url: e.url ?? openable(d.url ?? null), document: e.document ?? d});
      e.file = hasFile(e.document);
      changed();
    }, () => {});
    let r;
    try {
      r = await pages(e, e.query ? {q: e.query.slice(0, 300)} : {}, {signal: abort.signal});
    } catch (err) {
      const f = failure(err);
      if (f.code === 'cancelled' || v.entry !== e) return;
      if (f.status === 502) return unshowable(e, null);
      e.status = 'failed'; e.error = f;
      if (!e.reported) { e.reported = true; telemetry('view', false, e.opened, f.status ? `status:${f.status}` : undefined); }
      changed();
      if (!e.relatedAsked) askRelated(e); // the rail is bridge's other answer: it may well be there
      return;
    }
    if (v.entry !== e) return;
    if (!KINDS.includes(r?.kind)) return unshowable(e, r);
    if (r.url && openable(r.url)) e.url = r.url;
    e.answer = r; e.kind = r.kind; e.status = 'ready';
    if (r.kind === 'conversation' && r.title && !e.parent) e.title = e.title || r.title;
    if (r.kind === 'email' && r.subject) e.title = e.title || r.subject;
    if (r.kind === 'pages' && !(r.pages?.length)) { e.status = 'failed'; e.error = {code: 'http', message: 'This document has no pages.'}; }
    changed();
    if (r.kind === 'video' && r.ready === false) track(pollVideo(e));
    if (r.kind === 'email') track(images(e, false));
    // Related after the first page (bridge answers one request at a time: its work would hold the page up), 1.5 s at most
    if (r.kind === 'pages' || r.kind === 'video') timers.setTimeout(() => { if (v.entry === e && !e.relatedAsked) askRelated(e); }, 1500);
    else {
      v.firstPage(e, true);
      if (!e.relatedAsked) askRelated(e);
    }
  }

  /** none, an unknown kind or a 502: the document's page instead (SPEC.md, *Kinds*); the site's own document page keeps a state. */
  function unshowable(e, r) {
    const url = openable(r?.url ?? e.url ?? null);
    if (!e.reported) { e.reported = true; telemetry('view', true, e.opened); }
    if (embedded && !e.parent) { e.status = 'none'; e.kind = 'none'; e.answer = r; if (url) e.url = url; changed(); askRelated(e); return; }
    if (e.parent) { v.entry = e.parent; changed(); }
    else { v.entry = null; changed(); onClose(); }
    return outside(page(e, url));
  }

  async function loadRecent(e) {
    const it = e.recent;
    if (e.image) { e.kind = 'pages'; e.answer = {kind: 'pages', of: 'image', pages: [{w: 0, h: 0}], count: 1}; e.status = 'ready'; changed(); return; }
    if (it.kind === 'file') { e.kind = 'file'; e.status = 'ready'; v.firstPage(e, true); changed(); return; }
    try {
      const res = await get(host.resource(`/local/recent/${it.id}`), {signal: e.abort.signal});
      if (!res.ok) throw Object.assign(new Error(`HTTP ${res.status}`), {code: 'http', status: res.status});
      const text = await res.text();
      if (v.entry !== e) return;
      e.kind = 'text'; e.answer = {kind: 'text', text}; e.status = 'ready';
      v.firstPage(e, true);
    } catch (err) {
      const f = failure(err);
      if (f.code === 'cancelled' || v.entry !== e) return;
      e.status = 'failed'; e.error = f;
      v.firstPage(e, false);
    }
    changed();
  }

  function askRelated(e) {
    e.relatedAsked = true;
    if (v.hasRail(e)) track(loadRelated(e.id));
  }
  async function loadRelated(id, again = false) {
    const have = v.related[id];
    if (have && !again && (have.busy || have.rail)) return;
    v.related = {...v.related, [id]: {busy: true, error: null, none: false, rail: null, more: {}}};
    changed();
    const t0 = now();
    let next;
    try {
      const r = await host.call('bridge.related', {id, limit: 5});
      const rail = relatedRail(r ?? {});
      next = {busy: false, error: null, none: false, rail, more: {}};
      telemetry('related', true, t0, `results:${rail.groups.reduce((n, g) => n + g.items.length, 0)}`);
    } catch (err) {
      const f = failure(err);
      next = {busy: false, error: f.status === 404 ? null : f, none: f.status === 404, rail: null, more: {}};
      telemetry('related', false, t0, f.status ? `status:${f.status}` : undefined);
    }
    v.related = {...v.related, [id]: next};
    changed();
  }
  /** Every item of one kind in the rail (the site, no palette): bridge's Related of that kind, 50 at most. */
  async function moreOf(id, kind) {
    const have = v.related[id];
    if (!have?.rail || have.more[kind]) return;
    have.more = {...have.more, [kind]: 'busy'};
    changed();
    try {
      const r = await host.call('bridge.related', {id, kinds: [kind], limit: 50});
      const full = relatedRail({...(r ?? {}), document: {id}}).groups.find(g => g.kind === kind);
      const cur = v.related[id];
      if (full && cur?.rail) cur.rail = {...cur.rail, groups: cur.rail.groups.map(g => g.kind === kind ? {...full, more: 0} : g)};
      if (cur) cur.more = {...cur.more, [kind]: true};
    } catch (err) {
      const cur = v.related[id];
      if (cur) cur.more = {...cur.more, [kind]: false};
      say(failure(err).message);
    }
    changed();
  }

  /** A video being prepared: its poster shows; `pages` again after Retry-After (the host passes it as `retryAfter`) until ready. */
  async function pollVideo(e) {
    const t0 = now();
    for (let i = 0; i < 300 && v.entry === e && e.answer?.ready === false; i++) {
      await new Promise(resolve => timers.setTimeout(resolve, retryDelay(now() - t0, e.answer.retryAfter)));
      if (v.entry !== e) return;
      try {
        const r = await pages(e);
        if (v.entry !== e || r?.kind !== 'video') return;
        e.answer = r;
        changed();
      } catch { /* asked again on the next turn */ }
    }
  }

  /** An email's images as data URLs (the frame loads nothing itself): inline ones at once, remote ones after Load images. */
  async function images(e, remote) {
    e.images ??= new Map();
    const paths = imagePaths(e.answer?.messages, remote).filter(p => !e.images.has(p));
    if (!paths.length || !get) return;
    await Promise.all(paths.map(async p => {
      try {
        const res = await get(host.resource(p), {signal: e.abort?.signal});
        if (!res.ok) return;
        const bytes = new Uint8Array(await res.arrayBuffer()), type = sniff(bytes);
        if (type && bytes.length < 5_500_000) e.images.set(p, dataUrl(bytes, type));
      } catch { /* one image missing: the frame keeps its alt */ }
    }));
    if (v.entry === e) changed();
  }

  host.on('hide', () => v.reset());
  return v;
}
