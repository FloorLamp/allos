import {MONEY_ARGS} from './money.js';
import {invalid} from './host.js';
import {habitatStream} from './stream.js';
// The site's host (bridge's web UI, deck.wang.team; contract/README.md): bridge's same-origin /api with the site's session (the family
// network, or a member's passkey sign-in: Caddy's, never a token), links in new tabs, the clipboard API, prefs and picks in
// localStorage, the filtered browse (bridge.facets, bridge.browse), the owner's corrections (bridge.correct, bridge.matches: bridge
// takes them from the owner only), what needs the owner (bridge.needs, bridge.need), the registry's backends (`<backend>.<op>`; Habitat's state stream as events). No Recent, transfers, drag, menus, window or telemetry: their ops
// answer `unsupported`, their caps are false.
import {HOST_API, HostError, emitter, hostError, openable, resourcePath} from './host.js';

import {backendDefinitions} from './backend-registry.js';
import {backendRoute} from './backends.js';

const qs = o => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v != null && v !== '') p.set(k, Array.isArray(v) ? v.join(',') : String(v)); const s = p.toString(); return s ? `?${s}` : ''; };
const docPath = a => `/doc/${a.id}${a.message != null ? `/message/${encodeURIComponent(a.message)}` : ''}${(a.attachments ?? []).map(n => `/attachment/${n}`).join('')}`;

/** Each bridge op as [method, path, body?] on the site (bridge's test checks every one has an /api route). */
export const ROUTES = {
  "money.overview": a => ['GET', `/money/api/overview${qs(a)}`],
  "money.spending": a => ['GET', `/money/api/spending${qs(a)}`],
  "money.merchant": a => ['GET', `/money/api/merchant/${a.id}`],
  "money.rules": a => ['GET', `/money/api/rules${qs(a)}`],
  "money.categories": a => ['GET', `/money/api/categories${qs(a)}`],
  "money.accountManagement": a => ['GET', `/money/api/account-management${qs(a)}`],
  "money.views": a => ['GET', `/money/api/views${qs(a)}`],
  "money.imports": a => ['GET', `/money/api/imports${qs(a)}`],
  "money.link": a => ['GET', `/money/api/link${qs(a)}`],
  "money.merchants.resolve": a => ['GET', `/money/api/merchants/resolve${qs(a)}`],
  "money.txns": a => ['GET', `/money/api/txns${qs(a)}`],
  "money.txn": a => ['GET', `/money/api/txn/${a.id}`],
  "money.facets": a => ['GET', `/money/api/facets${qs(a)}`],
  "money.reviews": a => ['GET', `/money/api/reviews${qs(a)}`],
  "money.needs": a => ['GET', `/money/api/needs${qs(a)}`],
  "money.subscriptions": a => ['GET', `/money/api/subscriptions${qs(a)}`],
  "money.accounts": a => ['GET', `/money/api/accounts${qs(a)}`],
  "money.investments": a => ['GET', `/money/api/investments${qs(a)}`],
  'bridge.attention': a => ['GET', '/api/attention'],
  'bridge.gaps': a => ['GET', '/api/gaps'],
  'bridge.ignored': a => ['GET', '/api/ignored'],
  'bridge.attentionRetry': a => ['POST', '/api/attention/retry', a],
  'bridge.attentionDismiss': a => ['POST', '/api/attention/dismiss', a],
  'bridge.gapDismiss': a => ['POST', '/api/gaps/dismiss', a],
  'bridge.restore': a => ['POST', '/api/restore', a],
  'bridge.texts': a => ['GET', `/api/texts${qs(a)}`],
  'bridge.textsPages': a => ['GET', `/api/texts/${encodeURIComponent(a.conv)}${a.message != null ? `/message/${encodeURIComponent(a.message)}` : ''}${(a.attachments ?? []).map(n => `/attachment/${n}`).join('')}/pages`],
  'bridge.textsConversation': a => ['GET', `/api/texts/${encodeURIComponent(a.conv)}/conversation${qs({cursor: a.cursor, dir: a.dir})}`],
  'bridge.find': a => ['GET', `/api/find${qs({q: a.q, limit: a.limit, phase: a.phase})}`],
  'bridge.ask': a => ['GET', `/api/ask${qs({q: a.q})}`],
  'bridge.doc': a => ['GET', `/api/doc/${a.id}`],
  'bridge.pages': a => ['GET', `/api${docPath(a)}/pages${qs({q: a.q})}`],
  'bridge.conversation': a => ['GET', `/api/doc/${a.id}/conversation${qs({cursor: a.cursor, dir: a.dir})}`],
  'bridge.related': a => ['GET', `/api/related/${a.id}${qs({kinds: a.kinds, limit: a.limit})}`],
  'bridge.clusters': a => ['GET', `/api/clusters${qs({all: a.all ? 1 : undefined})}`],
  'bridge.clusterEdit': a => { const {id, action, ...body} = a; return ['POST', `/api/cluster/${encodeURIComponent(id)}/${action}`, body]; },
  'bridge.cluster': a => ['GET', `/api/cluster/${encodeURIComponent(a.id)}`],
  'bridge.day': a => ['GET', `/api/day/${encodeURIComponent(a.date)}`],
  'bridge.subject': a => ['GET', `/api/subject${qs({name: a.name})}`],
  'bridge.facets': () => ['GET', '/api/facets'],
  'bridge.vehicles': () => ['GET', '/api/vehicles'],
  'bridge.properties': () => ['GET', '/api/properties'],
  'bridge.taxes': () => ['GET', '/api/taxes'],
  'bridge.taxPacket': a => ['GET', `/api/taxes/${a.year}`],
  'bridge.insurance': () => ['GET', '/api/insurance'],
  'bridge.things': () => ['GET', '/api/things'],
  'bridge.thing': a => ['GET', `/api/thing/${encodeURIComponent(a.id)}`],
  'bridge.papers': () => ['GET', '/api/papers'],
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

// Session renewal (contract/backends.md, *Session renewal*): a write to a backend whose definition names a `session` landing (rover's,
// flightplan's), answered 401 on deck.wang.team, rejects with `renew(page)`; renew keeps the write for at most five minutes and opens
// the landing, and `resume(page)` on the same URL afterwards retries it once.
const DECK = 'https://deck.wang.team', PENDING = 'deck.session.pending', PENDING_MS = 300000;
/** Whether a 401 on this op can renew: a write (not GET, not a read scope) to a backend with a landing. */
const renewable = op => {
  const backend = op.slice(0, op.indexOf('.')), name = op.slice(backend.length + 1), definition = Object.hasOwn(backendDefinitions, backend) ? backendDefinitions[backend] : null;
  const route = definition?.session && Object.hasOwn(definition.ops, name) ? definition.ops[name] : null;
  return !!route && route.method !== 'GET' && !route.scope.endsWith(':read');
};
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
    if (backends.bridge && !op.startsWith('money.')) {
      // Keep bridge's established args and routes; only its destination changes.
      const configured = backends.bridge.origin;
      let u;
      try { u = new URL(configured); } catch { throw new HostError('not-set-up', 'invalid bridge origin'); }
      if (u.origin !== configured || !['https:', 'http:'].includes(u.protocol) || u.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(u.hostname))
        throw new HostError('not-set-up', 'invalid bridge origin');
      target = u.origin + path;
    }
    // Same-origin only: a custom header on a cross-origin call would add a preflight bridge does not answer (spaceport#568).
    return request(target, method, body, signal, backends.bridge && !op.startsWith('money.') ? 'include' : 'same-origin', false, !backends.bridge && !op.startsWith('money.'));
  }
  const flightplanCache = new Map();
  async function request(target, method, body, signal, credentials, strict = false, bridge = false) {
    const conditional = method === 'GET' && backends.flightplan?.origin && target.startsWith(backends.flightplan.origin + '/api/');
    const cached = conditional ? flightplanCache.get(target) : null;
    let res;
    try {
      res = await win.fetch(target, {method, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000), credentials, redirect: 'error', ...(body ? {body: JSON.stringify(body)} : {}),
        headers: {accept: 'application/json', ...(cached ? {'If-None-Match': cached.etag} : {}), ...(bridge ? {'X-Deck-Surface': 'web'} : {}), ...(body ? {'content-type': 'application/json'} : {})}});
    } catch (e) { throw hostError(e); }
    if (res.status === 304 && cached) return cached.answer;
    const answer = await res.json().catch(() => {
      if (strict) throw new HostError('http', 'invalid JSON', res.status);
      return {};
    });
    if (!res.ok) throw new HostError('http', strict ? `HTTP ${res.status}` : answer.error || `HTTP ${res.status}`, res.status);
    const etag = res.headers?.get?.('etag');
    if (conditional && etag) { if (flightplanCache.size >= 100) flightplanCache.delete(flightplanCache.keys().next().value); flightplanCache.set(target, {etag, answer}); }
    const retry = Number(res.headers?.get?.('retry-after'));
    if (retry > 0 && answer && typeof answer === 'object' && !Array.isArray(answer)) answer.retryAfter = retry;
    return answer;
  }
  // Habitat's state stream (`habitat.stream`, GET on its registry origin; `query.patterns` the entity globs): one socket with the
  // session's cookies; its changes are `habitat.state` events, its being open or lost `habitat.stream`. Closed, it reconnects
  // (1 s, doubling to 30 s). A second call replaces the first.
  const socketStream = habitatStream({openSocket: url => new win.WebSocket(url), emit: events.emit, subscribe: false});
  function stream(args, signal) {
    return socketStream.open(backendRoute(backends, 'habitat.stream', args, {web: true}), args, signal);
  }
  async function backend(op, args, signal, resumed = false) {
    if (op === 'habitat.stream') return stream(args, signal);
    // Browser events supply the gesture; never accept evidence from op args.
    const route = backendRoute(backends, op, args, {web: true, gesture: resumed || !!win.navigator?.userActivation?.isActive});
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
    try { return await request(route.url, route.method, route.body, signal, 'include', true); }
    catch (e) {
      if (e.status === 401 && renewable(op) && !resumed && win.location?.origin === DECK) {
        // Only the clicked write is kept; resume consumes it before retrying, so a refused retry never renews again.
        e.renew = page => {
          const href = win.location.href;
          win.sessionStorage.setItem(PENDING, JSON.stringify({page, href, op, args, at: Date.now()}));
          win.location.assign(new URL(`${backendDefinitions[op.split('.')[0]].session}?to=${encodeURIComponent(href)}`, route.url).href);
        };
      }
      throw e;
    }
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
    /** The write `renew(page)` kept, retried once when `page` starts again on the URL it left; else null. Another page's stays. */
    async resume(page) {
      const raw = win.sessionStorage?.getItem(PENDING);
      if (!raw) return null;
      let pending;
      try { pending = JSON.parse(raw); } catch { pending = null; }
      if (pending && pending.page !== page) return null;
      win.sessionStorage.removeItem(PENDING);
      if (!pending || win.location?.origin !== DECK || pending.href !== win.location.href || typeof pending.op !== 'string' ||
          !renewable(pending.op) || !Number.isFinite(pending.at) || Date.now() - pending.at < 0 || Date.now() - pending.at > PENDING_MS) return null;
      return backend(pending.op, pending.args, undefined, true);
    },
    /** The registry's backend names (the nav this host can offer). */
    backends: Object.keys(backends),
    caps: {projects: true, recent: false, transfers: false, actions: true, clipboard: true, files: false, drag: false, menus: false, window: false, telemetry: false, picks: true, browse: true, usage: true, corrections: true, texts: true, needs: true, codes: false, money: true},
    async call(op, args = {}, {signal} = {}) {
      if (signal?.aborted) throw new HostError('cancelled');
      if (op.startsWith('money.')) {
        if (!this.caps.money || !MONEY_ARGS[op]) throw new HostError('unsupported');
        const why = invalid(MONEY_ARGS[op], args);
        if (why) throw new HostError('refused', why);
      }
      if (ROUTES[op]) return bridge(op, args, signal);
      if (local[op]) return local[op](args);
      if (/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(op) && Object.hasOwn(backends, op.split('.')[0])) return backend(op, args, signal);
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
