// Browser state for a mounted page. Documents, a record's full view (`?record=<id>`) and an opened row (`#<id>`) add entries; switching
// the opened row and tabs replace the hash.
export const documentId = value => /^[1-9]\d*$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
/** `onRecord(id | null, title)`: the record whose full view the URL names (`?record=<id>`), or none. */
export function pageNavigation(doc, onDocument, {parseDocument = documentId, onRecord = null} = {}) {
  const win = doc?.defaultView, listeners = new Set();
  let current = null, record = null, titled = null, stopped = false;
  const url = () => win ? new URL(win.location.href) : null;
  const apply = () => {
    if (stopped) return;
    const next = parseDocument(url()?.searchParams.get('doc'));
    if (next !== current) { current = next; onDocument?.(next); }
    const named = onRecord ? url()?.searchParams.get('record') || null : null;
    if (named !== record) { record = named; onRecord?.(named, named != null && titled?.id === named ? titled.title : null); }
    for (const fn of listeners) fn();
  };
  win?.addEventListener('popstate', apply);
  win?.addEventListener('hashchange', apply);
  return {
    get hash() { try { return decodeURIComponent(url()?.hash.slice(1) ?? ''); } catch { return ''; } },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    start() {
      // arriving on an opened row or a record's full view: the list under it in history, so Back (or Esc) lands there
      const next = url(), named = onRecord ? next?.searchParams.get('record') : null;
      if (next && (next.hash || named) && !win.history.state?.deckDrawer && !win.history.state?.deckRecord) {
        const list = url();
        list.hash = ''; list.searchParams.delete('record');
        win.history.replaceState({...win.history.state, deckListScroll: {x: win.scrollX, y: win.scrollY}}, '', list);
        if (next.hash) {
          const row = new URL(next);
          row.searchParams.delete('record');
          win.history.pushState({...win.history.state, deckDrawer: true}, '', row);
        }
        if (named) win.history.pushState({...win.history.state, deckDrawer: !!next.hash, deckRecord: true}, '', next);
      }
      apply();
    },
    get record() { return record; },
    /** A record's full view over the list (its row stays open under it): `?record=<id>`, Back or close returns to the list; `title`
     *  names it until its own read does. */
    openRecord(id, title = null) {
      if (id == null || !onRecord) return;
      titled = {id: String(id), title};
      const next = url();
      if (!next || next.searchParams.get('record') === String(id)) return;
      win.history.replaceState({...win.history.state, deckListScroll: {x: win.scrollX, y: win.scrollY}}, '', url());
      next.searchParams.set('record', String(id));
      next.hash = encodeURIComponent(String(id));
      win.history.pushState({...win.history.state, deckRecord: true}, '', next);
      apply();
    },
    open(id) {
      id = parseDocument(id);
      if (!id || id === current) return;
      const next = url();
      if (next) {
        const scroll = {x: win.scrollX, y: win.scrollY};
        win.history.replaceState({...win.history.state, deckListScroll: scroll}, '', next);
        next.searchParams.set('doc', id);
        win.history.pushState({...win.history.state, deckDocument: true}, '', next);
      }
      current = id; onDocument?.(id);
    },
    close() {
      if (win?.history.state?.deckDocument || win?.history.state?.deckRecord) { win.history.back(); return; }
      const next = url();
      if (next) { next.searchParams.delete('doc'); next.searchParams.delete('record'); win.history.replaceState(win.history.state, '', next); }
      if (current != null) { current = null; onDocument?.(null); }
      if (record != null) { record = null; onRecord?.(null); }
    },
    replaceHash(hash) {
      const next = url();
      if (!next) return;
      next.hash = hash ? encodeURIComponent(hash) : '';
      win.history.replaceState(win.history.state, '', next);
      for (const fn of listeners) fn();
    },
    selectHash(hash) {
      const next = url();
      if (!next) return;
      const value = hash ? encodeURIComponent(hash) : '';
      if (value === next.hash.slice(1)) return;
      if (hash) {
        next.hash = value;
        if (win.history.state?.deckDrawer) win.history.replaceState(win.history.state, '', next);
        else {
          const scroll = {x: win.scrollX, y: win.scrollY};
          win.history.replaceState({...win.history.state, deckListScroll: scroll}, '', url());
          win.history.pushState({...win.history.state, deckDrawer: true}, '', next);
        }
      } else if (win.history.state?.deckDrawer) { win.history.back(); return; }
      else { next.hash = ''; win.history.replaceState(win.history.state, '', next); }
      for (const fn of listeners) fn();
    },
    restoreScroll() {
      const scroll = win?.history.state?.deckListScroll;
      if (scroll) win.requestAnimationFrame(() => { if (!stopped && current == null) win.scrollTo(scroll.x, scroll.y); });
    },
    stop() { stopped = true; listeners.clear(); win?.removeEventListener('popstate', apply); win?.removeEventListener('hashchange', apply); },
  };
}
