import {untilWarm} from './host/host.js';

/** Notes keep a durable outbox before sending. Each save is an idempotent full-text upsert. `error`: the list or a note could not be
 *  read (the page's state); `saveError`: changes are kept on this device, not yet sent (or stored); `saved`: this session sent one. */
export function createNotes(host, {delay = 500, clock = globalThis, uuid = () => crypto.randomUUID()} = {}) {
  const listeners = new Set();
  let timer, stopped = false, running, retryRequested = false, persist = Promise.resolve();
  const notify = () => { if (!stopped) for (const fn of listeners) fn(); };
  const model = {
    loading: true, warming: false, items: [], pending: {}, selected: null, error: null, saveError: null, saving: false, saved: false, editing: false,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    /** Every note, newest first. */
    get sorted() { return [...model.items].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at))); },
    get note() { return model.items.find(n => n.id === model.selected); },
    toggleEdit() { model.editing = !model.editing; notify(); },
    select(id) { model.selected = id; model.editing = false; notify(); },
    async open(id) {
      model.select(id);
      const before = model.items.find(n => n.id === id);
      try {
        const answer = await host.call('bridge.notes.get', {query: {id}});
        if (!model.pending[id] && model.items.find(n => n.id === id) === before) merge([answer.note]);
        notify();
      } catch (error) { model.error = error; notify(); }
    },
    newNote() {
      const id = uuid();
      merge([{id, text: '', title: '', updated_at: new Date().toISOString()}]);
      model.selected = id; model.editing = true; notify();
    },
    edit(text) {
      const note = {...model.note, title: text.split('\n')[0], text, updated_at: new Date().toISOString()};
      if (!note.id) return;
      merge([note]); model.pending[note.id] = note; model.saveError = null;
      // Snapshot immediately, serialized so an older persistence call cannot overwrite newer edits.
      remember(); notify();
      clock.clearTimeout(timer);
      timer = clock.setTimeout(() => model.flush(), delay);
    },
    async refresh() {
      const before = new Map(model.items.map(n => [n.id, n]));
      try {
        // bridge answers 503 warming just after a start: asked again until it answers, the page saying it is starting
        const answer = await untilWarm(() => host.call('bridge.notes.list', {}), {onWarming: () => { model.warming = true; notify(); }});
        // A read begun before input must not replace that input, even if its save has finished.
        const edited = model.items.filter(n => before.get(n.id) !== n);
        model.items = answer.notes ?? [];
        merge([...edited, ...Object.values(model.pending)]);
        model.error = null;
      } catch (error) { model.error = error; }
      model.warming = false; notify();
    },
    async flush() {
      if (running) { retryRequested = true; return running; }
      retryRequested = false;
      // nothing to send: nothing to report, and the list's own state stands
      if (!Object.keys(model.pending).length) return;
      running = (async () => {
        model.saving = true; notify();
        try {
          await persist;
          for (const note of Object.values(model.pending)) {
            await host.call('bridge.notes.save', {query: {id: note.id}, body: {text: note.text}});
            for (const [index, line] of note.text.split('\n').entries()) {
              const checkbox = /^\s*- \[([ xX])\]\s+(.+?)\s*$/.exec(line);
              if (!checkbox || !checkbox[2].trim()) continue;
              const item = await host.call('flightplan.notes.upsert', {body: {
                key: `deck-note:${note.id}:${index + 1}`, title: checkbox[2], kind: 'todo',
                links: [{type: 'url', ref: `deck-note:${note.id}`, url: `https://deck.wang.team/notes#${encodeURIComponent(note.id)}`}],
              }});
              if (checkbox[1] !== ' ' && item.status !== 'done') {
                await host.call('flightplan.notes.done', {query: {id: String(item.id)}, body: {}});
              }
            }
            if (model.pending[note.id] === note) delete model.pending[note.id];
            await remember();
          }
          model.saveError = null; model.saved = true;
        } catch (error) { model.saveError = error; }
        finally { model.saving = false; notify(); }
      })();
      await running; running = null;
      // New edits and explicit retries during a request get another pass, even if that request failed.
      if ((retryRequested || !model.saveError) && Object.keys(model.pending).length && !stopped) return model.flush();
    },
    async start() {
      try {
        const {value: saved} = await host.call('prefs.get', {key: 'notesOutbox'});
        model.pending = JSON.parse(saved || '{}');
        merge(Object.values(model.pending));
      } catch (error) { model.saveError = error; }
      await model.refresh();
      await model.flush();
      model.loading = false; notify();
    },
    stop() { stopped = true; clock.clearTimeout(timer); listeners.clear(); },
  };
  function merge(notes = []) {
    model.items = [...new Map([...model.items, ...notes].filter(Boolean).map(n => [n.id, n])).values()];
  }
  function remember() {
    const value = JSON.stringify(model.pending);
    persist = persist.catch(() => {}).then(() => host.call('prefs.set', {key: 'notesOutbox', value}));
    // Report storage failures without dropping the in-memory draft or sending before durable storage succeeds.
    persist.catch(error => { model.saveError = error; notify(); });
    return persist;
  }
  return model;
}
