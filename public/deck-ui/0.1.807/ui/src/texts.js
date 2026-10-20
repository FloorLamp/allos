import {HostError, readBridge} from './host/host.js';
import {textsLine} from './controller.js';
import {listWhen} from './format.js';

const LIMIT = 100;
/** A name that is only a number, a short code or nothing: no one the owner saved (`(863) 578-7356`, `70462`, `unknown`). */
const NUMBER = /^(?:[+\d\s().-]*\d[+\d\s().-]*|unknown)$/i;
/** A business's own name at the head of its text (`CVS Pharmacy: Hi …`, `Toastique:: …`): up to three capitalised words. */
const SENDER = /^((?:[A-Z][\p{L}\d&'’.-]*)(?: [A-Z][\p{L}\d&'’.-]*){0,2}):+\s+(?=\S)/u;

/** A conversation as the Texts page lists it (bridge CONTRACT.md, *Texts, the list*): who it is with (`title`, the registry's `person`
 *  when bridge resolved one), whether it is a person's or a business's (`kind`: bridge's, else a number or short code is a business's),
 *  a one-time code's (`code`), its newest message as one line with links shortened, and when. */
export function textsRow(x, now = new Date()) {
  const name = String(x.person?.name || x.name || '').trim();
  const number = !x.person && NUMBER.test(name);
  const kind = x.kind === 'person' || x.kind === 'business' ? x.kind : number || !name ? 'business' : 'person';
  const text = String(x.last?.text ?? '').replace(/\s+/g, ' ').trim();
  // a number's own name for itself, when its text opens with one: the title, the number beside it
  const head = kind === 'business' && number && !x.last?.me ? SENDER.exec(text) : null, sender = head?.[1] ?? null;
  const last = head ? {...x.last, text: text.slice(head[0].length)} : x.last;
  const title = sender ?? (number && /^unknown$/i.test(name) || !name ? 'Unknown sender' : name);
  return {id: `texts:${x.id}`, conversation: x.id, title, from: sender && !/^unknown$/i.test(name) ? name : null,
    kind, group: !!x.group, code: x.last?.hidden === 'code', person: x.person ?? null,
    line: textsLine(last, !!x.group), at: x.last?.at ?? null, when: listWhen(x.last?.at, now),
    document: {id: `texts:${x.id}`, title, type: 'texts', source: 'messages', date: listWhen(x.last?.at, now), url: x.url ?? null}};
}

/** The Texts list in bridge's cursor pages, newest first: `more()` adds the next page under the ones shown (`next` a next page exists);
 *  Refresh reads the first page again in their place. */
export function createTexts(host, {now = () => new Date()} = {}) {
  const listeners = new Set();
  let request, stopped = false;
  const notify = () => { if (!stopped) for (const fn of listeners) fn(); };
  const rowsOf = answer => (answer?.conversations ?? []).map(x => textsRow(x, now()));
  const merged = (rows, more) => [...new Map([...rows, ...more].map(row => [row.id, row])).values()];
  async function load(cursor) {
    if (stopped) return;
    request?.abort();
    const current = request = new AbortController();
    model.warming = false; model.error = null;
    if (cursor) model.adding = true; else model.loading = true;
    notify();
    try {
      if (!host.caps.texts) throw new HostError('unsupported');
      const answer = await readBridge(host, 'bridge.texts', {limit: LIMIT, ...(cursor ? {cursor} : {})}, {signal: current.signal,
        snapshot: answer => { if (!cursor && !model.items.length) { model.items = rowsOf(answer); notify(); } },
        warming: () => { if (!current.signal.aborted && !stopped) { model.warming = true; notify(); } },
      });
      if (current.signal.aborted || stopped) return;
      model.items = merged(cursor ? model.items : [], rowsOf(answer));
      model.next = answer?.next ?? null;
    } catch (error) { if (!current.signal.aborted && !stopped) model[cursor ? 'moreError' : 'error'] = error; }
    finally { if (!current.signal.aborted && !stopped) { model.warming = false; model.loading = false; model.adding = false; notify(); } }
  }
  const model = {
    items: [], next: null, loading: false, adding: false, warming: false, error: null, moreError: null,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    refresh() { model.moreError = null; return load(null); },
    more() { if (!model.next || model.loading || model.adding) return Promise.resolve(); model.moreError = null; return load(model.next); },
    stop() { stopped = true; request?.abort(); listeners.clear(); },
  };
  return model;
}

/** The list as the page shows it: People (a person's or a group's conversations), then Businesses & alerts, their one-time codes
 *  folded into one row (`codes`) at its end. */
export function textsGroups(rows) {
  const people = rows.filter(r => r.kind === 'person' && !r.code), others = rows.filter(r => !people.includes(r));
  return {people, businesses: others.filter(r => !r.code), codes: others.filter(r => r.code)};
}
