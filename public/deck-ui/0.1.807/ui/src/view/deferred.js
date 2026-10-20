import {h} from '../../vendor/preact.mjs';
import {useEffect, useState} from '../../vendor/hooks.mjs';

// The views past a page's first screen (later.js) load the first time any of them shows: one module, so a bundled page
// (build-web.mjs) splits off one chunk for them all.
let loading = null;
export const later = () => loading ??= import('./later.js').catch(error => { loading = null; throw error; });

/** later.js's `name` with the other props; `fallback` until it loads, `failed(error, retry)` when it cannot. */
export function Later({name, fallback = null, failed = null, ...props}) {
  const [views, setViews] = useState(null), [error, setError] = useState(null), [retry, setRetry] = useState(0);
  useEffect(() => {
    if (views) return;
    let active = true;
    setError(null);
    later().then(m => { if (active) setViews(() => m); }, e => { if (active) setError(e); });
    return () => { active = false; };
  }, [retry]);
  if (error) return failed ? failed(error, () => setRetry(n => n + 1)) : null;
  return views ? h(views[name], props) : fallback;
}
