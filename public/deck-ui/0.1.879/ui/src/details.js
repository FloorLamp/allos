import {describeFailure} from './failure.js';
// The document pane's state (palette SPEC.md, *Details*), no DOM: what bridge read from one document (title, type, date, summary,
// facts by subject, fields, the text read) and, with the host's `corrections` cap, the owner's corrections of it as host ops
// (`bridge.correct`, contract/README.md): Edit and Revert the head, a fact's Wrong, Edit value and Revert, Same as… a subject (its matches
// from `bridge.matches`), Unfold, Not a document and Restore, Re-read (bridge's preview, then Save or Discard). Every write bridge
// answers with an undo is offered Undo for UNDO_MS (allos's undo contract; bridge re-checks it). views/viewer/details.js draws it;
// npm test drives it with the fake host.
import {hostError} from './host/host.js';

/** How long Undo is offered after a write (allos's UNDO_TOAST_MS; bridge keeps its own, longer window). */
export const UNDO_MS = 15_000;
export const HEAD = ['title', 'type', 'date', 'summary'];
/** Sources whose documents a model read (a file, a mail): Re-read and Not a document mean something there; a source's own rows (a
 *  calendar's event, an order's export, the house's records) were never read so. */
export const READ_SOURCES = ['seafile', 'immich', 'gmail', 'email', 'kb'];
/** A field that is a machine's id (`iCalUID`, a message id, `recurringEventId`, `thread_id`), never shown: a person's `Order ID` stays. */
export const internalField = name => /^(?:iCalUID|UID|uid|UUID|uuid|GUID|guid)$/.test(name) || /^message-?id$/i.test(name) || /^[a-z][a-zA-Z0-9]*Id$/.test(name) || /^[a-z0-9]+(?:_[a-z0-9]+)*_id$/.test(name);


/** What a write says on the status line, and its Undo's subject. */
const SAID = {
  edit: b => `${Object.keys(b.set).map(k => k === 'type' ? 'Type' : k[0].toUpperCase() + k.slice(1)).join(', ')} saved`,
  revert: b => `${b.fields.map(k => k[0].toUpperCase() + k.slice(1)).join(', ')} back to what was read`,
  wrong: () => 'Marked wrong: hidden', unwrong: () => 'Fact back', value: () => 'Value saved', unvalue: () => 'Value back to what was read',
  fold: b => `${b.subject} is now ${b.into}`, unfold: () => 'Unfolded', ignore: () => 'Not a document: out of search and answers',
  restore: () => 'Restored', save: () => 'Re-read saved', undo: () => 'Undone',
};

/** opts: `onChange(doc)` after any write (the site's head follows the title), `now`, `timers`. */
export function createDetails(host, {onChange = () => {}, now = () => Date.now(), timers = globalThis} = {}) {
  const listeners = new Set();
  let undoTimer = null, matchSeq = 0;
  const d = {
    host,
    id: null,
    /** loading, ready, failed. */
    status: 'loading',
    doc: null,
    error: null,
    /** A write under way: its action ('reread' while bridge reads it again). */
    busy: null,
    /** The status line: {text, bad?, undo?: correction id, until?}. */
    note: null,
    /** What is being edited: 'head', {fact: id}, {same: subject} (Same as…). */
    editing: null,
    /** Same as…'s matches: {subject, q, busy, items, error}. */
    matches: null,
    /** A re-read's preview: bridge's {token, changed, head, status, facts, fields, text}. */
    preview: null,
    /** The record the viewer shows of it (record.js), else null: the pane then shows only what the record does not. */
    record: null,

    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Whether the owner's corrections show (the host's cap). */
    get can() { return !!host.caps.corrections; },
    /** Whether Re-read and Not a document show: the corrections, on a document a model read (READ_SOURCES). */
    get rereads() { return d.can && READ_SOURCES.includes(d.doc?.source); },
    async load(id) {
      d.id = Number(id);
      Object.assign(d, {status: 'loading', doc: null, error: null, editing: null, matches: null, preview: null, note: null});
      changed();
      try {
        const doc = await host.call('bridge.doc', {id: d.id});
        if (d.id !== Number(id)) return;
        Object.assign(d, {doc, status: 'ready'});
      } catch (e) {
        if (d.id !== Number(id)) return;
        Object.assign(d, {status: 'failed', error: failure(e)});
      }
      changed();
    },
    /** A document bridge answered already (the site's page): shown without asking again. */
    show(doc) { Object.assign(d, {id: doc.id, doc, status: 'ready', error: null}); changed(); },
    retry() { return d.load(d.id); },
    setRecord(record) { if (d.record !== record) { d.record = record; changed(); } },

    /** The head's fields the owner edited (bridge's `edited`: what the reading says). */
    edited(k) { return !!d.doc?.edited && Object.hasOwn(d.doc.edited, k); },
    /** The facts grouped by subject, in bridge's order: [{subject, facts, fold?}] (`fold` the owner's that brought it together). */
    groups() {
      const out = new Map();
      for (const f of d.doc?.facts ?? []) {
        if (!out.has(f.subject)) out.set(f.subject, {subject: f.subject, facts: [], fold: (d.doc.folds ?? []).find(x => x.into === f.subject) ?? null});
        out.get(f.subject).facts.push(f);
      }
      return [...out.values()];
    },

    startEdit(what) { if (d.can && !d.busy) { d.editing = what; d.matches = null; changed(); } },
    cancelEdit() { d.editing = null; d.matches = null; changed(); },
    /** The head saved: only what changed goes (an unchanged field stays unlocked). */
    saveHead(values) {
      const set = Object.fromEntries(HEAD.filter(k => k in values && String(values[k] ?? '').trim() !== String(d.doc?.[k] ?? '')).map(k => [k, String(values[k] ?? '').trim()]));
      if (!Object.keys(set).length) return d.cancelEdit();
      return write({action: 'edit', set});
    },
    revert(fields) { return write({action: 'revert', fields: [fields].flat()}); },
    wrong(fact) { return write({action: 'wrong', fact: fact.id}); },
    unwrong(w) { return write({action: 'unwrong', wrong: w.id}); },
    saveValue(fact, value) {
      const v = String(value ?? '').trim();
      if (!v || v === fact.value) return d.cancelEdit();
      return write({action: 'value', fact: fact.id, value: v});
    },
    unvalue(fact) { return write({action: 'unvalue', fact: fact.id}); },
    /** Same as…: the matches for `subject` (`q`: what the owner typed), the latest asked only. */
    async findMatches(subject, q = '') {
      const seq = ++matchSeq;
      d.matches = {subject, q, busy: true, items: d.matches?.subject === subject ? d.matches.items : [], error: null};
      changed();
      try {
        const r = await host.call('bridge.matches', {name: subject, ...(q.trim() ? {q: q.trim().slice(0, 100)} : {})});
        if (seq !== matchSeq) return;
        d.matches = {subject, q, busy: false, items: r?.matches ?? [], error: null};
      } catch (e) {
        if (seq !== matchSeq) return;
        d.matches = {subject, q, busy: false, items: [], error: failure(e)};
      }
      changed();
    },
    fold(subject, into) { return write({action: 'fold', subject, into}); },
    unfold(fold) { return write({action: 'unfold', fold: fold.id}); },
    ignore() { return write({action: 'ignore'}); },
    restore() { return write({action: 'restore'}); },
    /** Re-read: bridge reads it again (the model asked) and answers what saving would change; nothing is saved yet. */
    async reread() {
      if (!d.can || d.busy) return;
      d.busy = 'reread'; d.preview = null; d.editing = null; d.note = null;
      changed();
      try {
        const r = await host.call('bridge.correct', {id: d.id, action: 'reread'});
        d.preview = r?.preview ?? null;
        if (r?.document) d.doc = r.document;
      } catch (e) {
        d.note = {text: `Couldn’t read it again: ${failure(e).message}`, bad: true};
      } finally { d.busy = null; changed(); }
    },
    save() { const p = d.preview; return p ? write({action: 'save', token: p.token}) : Promise.resolve(); },
    discard() { d.preview = null; changed(); },
    /** Undo the last write, while it is offered. */
    undo() {
      const u = d.note?.undo;
      if (!u || now() > d.note.until) return Promise.resolve();
      return write({action: 'undo', undo: u});
    },
    /** A fact's value copied (the clipboard cap). */
    copy(text) {
      if (!host.caps.clipboard) return Promise.resolve();
      return host.call('clipboard.copy', {text: String(text).slice(0, 100000), sensitive: false})
        .then(() => { d.note = {text: 'Copied'}; changed(); }, e => { d.note = {text: describeFailure('This device’s clipboard', e).message, bad: true}; changed(); });
    },
    /** A fact's link opened (the browser, the OS's). */
    open(url) { return /^https?:\/\//i.test(url) ? host.call('url.open', {url}).catch(() => {}) : Promise.resolve(); },
    /** Settles once nothing it started is still running. */
    async idle() { while (pending.size) await Promise.allSettled([...pending]); },
  };
  const pending = new Set();

  function changed() { for (const fn of listeners) fn(d); }
  const failure = e => { const h = hostError(e); return {code: h.code, ...(h.status ? {status: h.status} : {}), message: describeFailure('bridge', h).message}; };

  function write(body) {
    if (!d.can || d.busy || d.id == null) return Promise.resolve();
    const p = (async () => {
      d.busy = body.action;
      changed();
      try {
        const r = await host.call('bridge.correct', {id: d.id, ...body});
        if (r?.document) d.doc = r.document;
        d.editing = null; d.matches = null;
        if (body.action === 'save') d.preview = null;
        timers.clearTimeout(undoTimer);
        d.note = {text: SAID[body.action](body), ...(r?.undo ? {undo: r.undo, until: now() + UNDO_MS} : {})};
        if (r?.undo) undoTimer = timers.setTimeout(() => { if (d.note?.undo === r.undo) { d.note = {text: d.note.text}; changed(); } }, UNDO_MS);
        onChange(d.doc);
      } catch (e) {
        const f = failure(e);
        if (body.action === 'save' && [409, 410].includes(f.status)) d.preview = null;
        d.note = {text: f.message, bad: true};
      } finally { d.busy = null; changed(); }
    })();
    pending.add(p);
    p.finally(() => pending.delete(p));
    return p;
  }

  return d;
}
