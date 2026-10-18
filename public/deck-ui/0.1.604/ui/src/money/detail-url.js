// Drawer navigation changes only selection; the mounted list and filters stay in place.
export function createDetailURL({key, show, getURL, setURL, based, window, web, replace, onDispose}) {
  let pushed = false;
  const sync = () => show(getURL().searchParams.get(key));
  const pop = () => { setURL(new URL(window.location.href)); sync(); };
  window.addEventListener('popstate', pop);
  onDispose(() => window.removeEventListener('popstate', pop));
  return {
    open(id) {
      const url = getURL();
      if (url.searchParams.get(key) === String(id)) return sync();
      url.searchParams.set(key, id);
      const href = based(url.pathname + url.search);
      if (web) window.history.pushState(null, '', href);
      else replace(href);
      pushed = true;
      return sync();
    },
    close() {
      if (pushed && web) {
        pushed = false;
        getURL().searchParams.delete(key);
        sync();
        window.history.back();
      }
      else {
        const url = getURL(); url.searchParams.delete(key);
        replace(based(url.pathname + url.search));
        return sync();
      }
    },
    sync,
  };
}
