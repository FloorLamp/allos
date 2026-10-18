// Browser state for a mounted page. Documents and drawers add entries; drawer switches and tabs replace the hash.
export const documentId = value => /^[1-9]\d*$/.test(String(value ?? '')) && Number.isSafeInteger(Number(value)) ? Number(value) : null;
export function pageNavigation(doc, onDocument, {parseDocument = documentId} = {}) {
  const win = doc?.defaultView, listeners = new Set();
  let current = null, stopped = false;
  const url = () => win ? new URL(win.location.href) : null;
  const apply = () => {
    if (stopped) return;
    const next = parseDocument(url()?.searchParams.get('doc'));
    if (next !== current) { current = next; onDocument?.(next); }
    for (const fn of listeners) fn();
  };
  win?.addEventListener('popstate', apply);
  win?.addEventListener('hashchange', apply);
  return {
    get hash() { try { return decodeURIComponent(url()?.hash.slice(1) ?? ''); } catch { return ''; } },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    start() {
      const next = url();
      if (next?.hash && !win.history.state?.deckDrawer) {
        const hash = next.hash;
        next.hash = '';
        win.history.replaceState({...win.history.state, deckListScroll: {x: win.scrollX, y: win.scrollY}}, '', next);
        next.hash = hash;
        win.history.pushState({...win.history.state, deckDrawer: true}, '', next);
      }
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
      if (win?.history.state?.deckDocument) { win.history.back(); return; }
      const next = url();
      if (next) { next.searchParams.delete('doc'); win.history.replaceState(win.history.state, '', next); }
      current = null; onDocument?.(null);
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
