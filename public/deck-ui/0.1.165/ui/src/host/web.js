// The site's host (bridge's web UI, deck.wang.team; CONTRACT.md): bridge's same-origin /api with the site's session (the family
// network, or a member's passkey sign-in: Caddy's, never a token), links in new tabs, the clipboard API, prefs and picks in
// localStorage, the filtered browse (bridge.facets, bridge.browse), the owner's corrections (bridge.correct, bridge.matches: bridge
// takes them from the owner only), what needs the owner (bridge.needs, bridge.need), the registry's backends (`<backend>.<op>`; Habitat's state stream as events). No Recent, transfers, drag, menus, window or telemetry: their ops
// answer `unsupported`, their caps are false.
import {HOST_API, HostError, emitter, hostError, openable, resourcePath} from './host.js';

import {backendRoute} from './backends.js';

const qs = o => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v != null && v !== '') p.set(k, Array.isArray(v) ? v.join(',') : String(v)); const s = p.toString(); return s ? `?${s}` : ''; };
const docPath = a => `/doc/${a.id}${a.message != null ? `/message/${encodeURIComponent(a.message)}` : ''}${(a.attachments ?? []).map(n => `/attachment/${n}`).join('')}`;

/** Each bridge op as [method, path, body?] on the site (bridge's test checks every one has an /api route). */
export const ROUTES = {
  'bridge.find': a => ['GET', `/api/find${qs({q: a.q, limit: a.limit, phase: a.phase})}`],
  'bridge.ask': a => ['GET', `/api/ask${qs({q: a.q})}`],
  'bridge.doc': a => ['GET', `/api/doc/${a.id}`],
  'bridge.pages': a => ['GET', `/api${docPath(a)}/pages${qs({q: a.q})}`],
  'bridge.conversation': a => ['GET', `/api/doc/${a.id}/conversation${qs({cursor: a.cursor, dir: a.dir})}`],
  'bridge.related': a => ['GET', `/api/related/${a.id}${qs({kinds: a.kinds, limit: a.limit})}`],
  'bridge.project': a => ['GET', `/api/project/${encodeURIComponent(a.id)}`],
  'bridge.day': a => ['GET', `/api/day/${encodeURIComponent(a.date)}`],
  'bridge.subject': a => ['GET', `/api/subject${qs({name: a.name})}`],
  'bridge.facets': () => ['GET', '/api/facets'],
  'bridge.people': a => ['GET', `/api/people${qs({q: a.q, relation: a.relation})}`],
  'bridge.browse': a => ['GET', `/api/browse${qs({source: a.source, type: a.type, year: a.year, sort: a.sort})}`],
  'bridge.usage': a => ['GET', `/api/usage${qs({doc: a.doc})}`],
  'bridge.actions': () => ['GET', '/api/actions'],
  'bridge.act': a => ['POST', `/api/actions/${encodeURIComponent(a.id)}`],
  'bridge.correct': ({id, ...body}) => ['POST', `/api/doc/${id}/correct`, body],
  'bridge.matches': a => ['GET', `/api/subjects/match${qs({name: a.name, q: a.q})}`],
  'bridge.needs': () => ['GET', '/api/needs'],
  'bridge.need': a => ['POST', `/api/needs/${encodeURIComponent(a.id)}`, {}],
};

/** A resource path (`/v1/doc/7/page/2?w=1600`) as the site serves it (`/api/doc/7/page/2?w=1600`); null off the allowlist. */
export const webResource = path => resourcePath(path) ? path.replace(/^\/v1\//, '/api/') : null;

const PICKS = 'deck.picks', PREFS = 'deck.prefs', MAX_PICKS = 200;

/** win: the browser's window (fetch, open, navigator, localStorage, matchMedia); tests pass their own. */
export function webHost(win = globalThis, {backends = {}} = {}) {
  const events = emitter();
  const store = {
    read(k) { try { return JSON.parse(win.localStorage?.getItem(k) ?? '{}') ?? {}; } catch { return {}; } },
    write(k, v) { try { win.localStorage?.setItem(k, JSON.stringify(v)); } catch { /* private mode: picks and prefs last the page */ } },
  };
  async function bridge(op, args, signal) {
    const [method, path, body] = ROUTES[op](args);
    let target = path;
    if (backends.bridge) {
      // Keep bridge's established args and routes; only its destination changes.
      const configured = backends.bridge.origin;
      let u;
      try { u = new URL(configured); } catch { throw new HostError('not-set-up', 'invalid bridge origin'); }
      if (u.origin !== configured || !['https:', 'http:'].includes(u.protocol) || u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
        throw new HostError('not-set-up', 'invalid bridge origin');
      target = u.origin + path;
    }
    return request(target, method, body, signal, backends.bridge ? 'include' : 'same-origin');
  }
  async function request(target, method, body, signal, credentials, strict = false) {
    let res;
    try {
      res = await win.fetch(target, {method, signal, credentials, redirect: 'error', ...(body ? {body: JSON.stringify(body)} : {}),
        headers: {accept: 'application/json', ...(body ? {'content-type': 'application/json'} : {})}});
    } catch (e) { throw hostError(e); }
    const answer = await res.json().catch(() => {
      if (strict) throw new HostError('http', 'invalid JSON', res.status);
      return {};
    });
    if (!res.ok) throw new HostError('http', strict ? `HTTP ${res.status}` : answer.error || `HTTP ${res.status}`, res.status);
    const retry = Number(res.headers?.get?.('retry-after'));
    if (retry > 0 && answer && typeof answer === 'object' && !Array.isArray(answer)) answer.retryAfter = retry;
    return answer;
  }
  // Habitat's state stream (`habitat.stream`, GET on its registry origin; `query.patterns` the entity globs): one socket with the
  // session's cookies; its changes are `habitat.state` events, its being open or lost `habitat.stream`. Closed, it reconnects
  // (1 s, doubling to 30 s). A second call replaces the first.
  let socket = null, wait = 1000, retry = null;
  function stream(args) {
    const route = backendRoute(backends, 'habitat.stream', args, {web: true});
    const url = new URL(route.url);
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    clearTimeout(retry);
    const old = socket;
    socket = null;
    old?.close();
    const connect = () => {
      const ws = socket = new win.WebSocket(url.href);
      ws.onopen = () => { wait = 1000; events.emit('habitat.stream', {live: true}); };
      ws.onmessage = e => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m?.type === 'state_changed' && typeof m.entity_id === 'string') events.emit('habitat.state', {entity_id: m.entity_id, new: m.new ?? null});
      };
      ws.onclose = () => {
        if (socket !== ws) return;
        events.emit('habitat.stream', {live: false});
        retry = setTimeout(connect, wait);
        wait = Math.min(wait * 2, 30000);
      };
    };
    connect();
    return {};
  }
  async function backend(op, args, signal) {
    if (op === 'habitat.stream') return stream(args);
    if (op.endsWith('.need') && Object.hasOwn(args, 'id')) {
      if (!/^[a-z0-9][a-z0-9:._@-]{0,199}$/.test(args.id ?? '') || Object.keys(args).some(k => k !== 'id'))
        throw new HostError('refused', 'invalid need id');
      if (!win.navigator?.userActivation?.isActive) throw new HostError('refused', 'need requires a click or key');
      const route = backendRoute(backends, op.replace(/\.need$/, '.needs'), {}, {web: true});
      return request(`${route.url}/${encodeURIComponent(args.id)}`, 'POST', {}, signal, 'include', true);
    }
    // Browser events supply the gesture; never accept evidence from op args.
    const route = backendRoute(backends, op, args, {web: true, gesture: !!win.navigator?.userActivation?.isActive});
    if (op === 'habitat.snapshot') {
      if (route.method !== 'GET' || new URL(route.url).origin !== win.location.origin)
        throw new HostError('refused', 'snapshots require Habitat’s own origin');
      let res;
      try { res = await win.fetch(route.url, {signal, credentials: 'same-origin', redirect: 'error', cache: 'no-store'}); }
      catch (e) { throw hostError(e); }
      if (!res.ok) throw new HostError('http', `HTTP ${res.status}`, res.status);
      if (res.headers.get('content-type')?.split(';')[0] !== 'image/jpeg') throw new HostError('http', 'invalid snapshot');
      return {url: URL.createObjectURL(await res.blob())};
    }
    return request(route.url, route.method, route.body, signal, 'include', true);
  }
  const open = url => { win.open(url, '_blank', 'noopener'); return null; };
  const local = {
    'env.get': () => ({platform: 'web', mod: /Mac|iPhone|iPad/.test(win.navigator?.platform ?? '') ? 'Meta' : 'Control',
      theme: win.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
      highContrast: !!win.matchMedia?.('(forced-colors: active)').matches, reduceMotion: !!win.matchMedia?.('(prefers-reduced-motion: reduce)').matches,
      bridgeSetUp: true, version: null}),
    'bridge.prefetch': () => null,
    'document.open': a => open(`/api/doc/${a.id}/file`),
    'document.page': a => open(openable(a.url) ?? `/doc/${a.id}`),
    'url.open': a => { if (!openable(a.url)) throw new HostError('refused', 'only http(s), mailto and tel'); return open(a.url); },
    'map.open': a => open(`/map${qs({[a.by]: a.value})}`),
    'clipboard.copy': async a => { try { await win.navigator.clipboard.writeText(a.text); } catch (e) { throw new HostError('refused', String(e?.message ?? e)); } return null; },
    'prefs.get': a => ({value: store.read(PREFS)[a.key] ?? null}),
    'prefs.set': a => { store.write(PREFS, {...store.read(PREFS), [a.key]: a.value}); return null; },
    'picks.list': () => ({picks: store.read(PICKS)}),
    'picks.add': a => {
      const picks = Object.entries({...store.read(PICKS), [a.id]: Date.now()}).sort((x, y) => y[1] - x[1]).slice(0, MAX_PICKS);
      store.write(PICKS, Object.fromEntries(picks));
      return null;
    },
    'telemetry.event': () => null,
  };
  return {
    kind: 'web', hostApi: HOST_API,
    /** The registry's backend names (the places this host can offer). */
    backends: Object.keys(backends),
    caps: {recent: false, transfers: false, actions: true, clipboard: true, files: false, drag: false, menus: false, window: false, telemetry: false, picks: true, browse: true, usage: true, corrections: true, texts: false, needs: true, codes: false},
    async call(op, args = {}, {signal} = {}) {
      if (signal?.aborted) throw new HostError('cancelled');
      if (ROUTES[op]) return bridge(op, args, signal);
      if (local[op]) return local[op](args);
      if (/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/.test(op) && Object.hasOwn(backends, op.split('.')[0])) return backend(op, args, signal);
      throw new HostError('unsupported', `${op} is not on the site`);
    },
    resource(path, args, options) {
      if (path === 'habitat.snapshot') return backend(path, args, options?.signal);
      const url = webResource(path);
      if (!url) throw new HostError('refused', 'not a resource path');
      return url;
    },
    on: events.on,
    /** The page's own events (a theme change), for the UI. */
    emit: events.emit,
  };
}
