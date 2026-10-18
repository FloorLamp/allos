/** A visible Flightplan page checks a cheap change marker. Older hosts retain bounded automatic refresh. */
export function watchFlightplan({read, refresh, busy, error, document: doc = globalThis.document, timers = globalThis}) {
  let stopped = false, timer = null, pending = null, request = null, version, fallback = false, retryMs = 0;
  const visible = () => !doc?.hidden;
  const schedule = () => {
    timers.clearTimeout(timer);
    if (!stopped && doc && visible()) {
      timer = timers.setTimeout(() => check(), retryMs || (fallback ? 15000 : 5000));
      timer?.unref?.();
    }
  };
  const check = () => {
    if (stopped || !visible()) return Promise.resolve();
    if (pending) return pending;
    timers.clearTimeout(timer);
    if (busy()) { schedule(); return Promise.resolve(); }
    const controller = request = new AbortController();
    pending = (async () => {
      try {
        let next;
        if (!fallback) {
          try {
            next = (await read({signal: controller.signal}))?.version;
            if (typeof next !== 'string') fallback = true;
          } catch (e) {
            if (['unsupported', 'not-set-up', 'refused'].includes(e?.code) || [404, 405].includes(e?.status)) fallback = true;
            else throw e;
          }
        }
        if (stopped || controller.signal.aborted || !visible() || busy()) return;
        if (fallback || next !== version) {
          if (await refresh() === false) { retryMs = 30000; return; }
          version = next;
        }
        retryMs = 0; error(null);
      } catch (e) { if (!controller.signal.aborted) { retryMs = Math.max(30000, Number(e?.retryAfterMs) || Number(e?.retryAfter) * 1000 || 0); if (!stopped) error(e); } }
    })().finally(() => { pending = null; request = null; schedule(); });
    return pending;
  };
  const resume = () => { if (visible()) check(); else { timers.clearTimeout(timer); timer = null; request?.abort(); } };
  doc?.addEventListener('visibilitychange', resume);
  doc?.defaultView?.addEventListener('focus', resume);
  schedule();
  return {check, stop() { stopped = true; request?.abort(); timers.clearTimeout(timer); doc?.removeEventListener('visibilitychange', resume); doc?.defaultView?.removeEventListener('focus', resume); }};
}
