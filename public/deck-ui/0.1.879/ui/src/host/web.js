import {houseActionOps} from './house-actions.js';
import {MONEY_ARGS} from './money.js';
import {invalid, untilWarm} from './host.js';
import {habitatStream} from './stream.js';
import {cancelled, pageLife} from './page-life.js';
// The site's host (bridge's web UI, deck.wang.team; contract/README.md): bridge's same-origin /api with the site's session (the family
// network, or a member's passkey sign-in: Caddy's, never a token), links in new tabs, the clipboard API, prefs and picks in
// localStorage, the filtered browse (bridge.facets, bridge.browse), the owner's corrections (bridge.correct, bridge.matches: bridge
// takes them from the owner only), what needs the owner (bridge.needs, bridge.need), the registry's backends (`<backend>.<op>`; Habitat's state stream as events). No Recent, transfers, drag, menus, window or telemetry: their ops
// answer `unsupported`, their caps are false.
import {HOST_API, HostError, REQUEST_TIMEOUT_MS, emitter, hostError, openable, resourcePath} from './host.js';

import {CODE_MS} from '../codes.js';
import {backendRoute} from './backends.js';
import {backendDefinitions} from './backend-registry.js';
import {memberCan, pageMember} from './member.js';

const qs = o => { const p = new URLSearchParams(); for (const [k, v] of Object.entries(o)) if (v != null && v !== '') p.set(k, Array.isArray(v) ? v.join(',') : String(v)); const s = p.toString(); return s ? `?${s}` : ''; };
const docPath = a => `/doc/${a.id}${a.message != null ? `/message/${encodeURIComponent(a.message)}` : ''}${(a.attachments ?? []).map(n => `/attachment/${n}`).join('')}`;

/** Each bridge op as [method, path, body?] on the site (bridge's test checks every one has an /api route). */
export const ROUTES = {
  'codes.list': () => ['GET', '/api/codes'],
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
  'bridge.collectionDetails': a => ['GET', `/api/collection-details${qs(a)}`],
  'bridge.pages': a => ['GET', `/api${docPath(a)}/pages${qs({q: a.q})}`],
  'bridge.conversation': a => ['GET', `/api/doc/${a.id}/conversation${qs({cursor: a.cursor, dir: a.dir})}`],
  'bridge.related': a => ['GET', `/api/related/${a.id}${qs({kinds: a.kinds, limit: a.limit})}`],
  'bridge.clusters': a => ['GET', `/api/clusters${qs({all: a.all ? 1 : undefined})}`],
  'bridge.clusterEdit': a => { const {id, action, ...body} = a; return ['POST', `/api/cluster/${encodeURIComponent(id)}/${action}`, body]; },
  'bridge.cluster': a => ['GET', `/api/cluster/${encodeURIComponent(a.id)}`],
  'bridge.day': a => ['GET', `/api/day/${encodeURIComponent(a.date)}`],
  'bridge.subject': a => ['GET', `/api/subject${qs({name: a.name})}`],
  'bridge.expiring': a => ['GET', `/api/expiring${qs({days: a.days})}`],
  'bridge.obligations': () => ['GET', '/api/obligations'],
  'bridge.facets': () => ['GET', '/api/facets'],
  'bridge.vehicles': () => ['GET', '/api/vehicles'],
  'bridge.properties': () => ['GET', '/api/properties'],
  'bridge.locationHistory': a => ['GET', `/api/location-history${qs(a)}`],
  'bridge.taxes': () => ['GET', '/api/taxes'],
  'bridge.taxPacket': a => ['GET', `/api/taxes/${a.year}`],
  'bridge.insurance': () => ['GET', '/api/insurance'],
  'bridge.tower': a => { if (!['plans', 'live'].includes(a.name) || Object.keys(a).some(k => k !== 'name')) throw new HostError('refused', 'unknown Tower file'); return ['GET', `/api/tower/${a.name}.json`]; },
  'bridge.purchases': a => ['GET', `/api/purchases${qs(a.query ?? {})}`],
  'bridge.things': () => ['GET', '/api/things'],
  'bridge.thing': a => ['GET', `/api/thing/${encodeURIComponent(a.id)}`],
  'bridge.papers': () => ['GET', '/api/papers'],
  'bridge.peopleDuplicates': () => ['GET', '/api/people/duplicates'],
  'bridge.peopleDuplicateDecision': a => ['POST', '/api/people/duplicates', a],
  'bridge.peopleDuplicateUndo': a => ['POST', '/api/people/duplicates', {a: a.a, b: a.b, choice: 'undo'}],
  'bridge.peopleUnmerge': a => ['POST', `/api/people/${encodeURIComponent(a.id)}/unmerge`, {}],
  'bridge.personKind': a => ['PUT', `/api/people/${encodeURIComponent(a.id)}/kind`, {kind: a.kind}],
  'bridge.people': a => ['GET', `/api/people${qs({q: a.q, relation: a.relation})}`],
  'bridge.faces': a => ['GET', `/api/people/faces${qs({q: a.q, cursor: a.cursor})}`],
  'bridge.faceSuggestions': a => ['GET', `/api/people/${encodeURIComponent(a.id)}/faces/suggestions`],
  'bridge.faceLink': a => ['PUT', `/api/people/${encodeURIComponent(a.id)}/face`, {immich: a.immich, ...(a.move ? {move: true} : {})}],
  'bridge.faceUnlink': a => ['DELETE', `/api/people/${encodeURIComponent(a.id)}/face`],
  'bridge.faceNotIt': a => ['POST', `/api/people/${encodeURIComponent(a.id)}/face/not-it`, {immich: a.immich}],
  'bridge.browse': a => ['GET', `/api/browse${qs({source: a.source, type: a.type, year: a.year, sort: a.sort})}`],
  'bridge.usage': a => ['GET', `/api/usage${qs({doc: a.doc})}`],
  'bridge.correct': ({id, ...body}) => ['POST', `/api/doc/${id}/correct`, body],
  'bridge.matches': a => ['GET', `/api/subjects/match${qs({name: a.name, q: a.q})}`],
  'bridge.needs': () => ['GET', '/api/needs'],
  'bridge.need': a => ['POST', `/api/needs/${encodeURIComponent(a.id)}`, {}],
};

const withoutPhotos = answer => Array.isArray(answer?.results) ? {...answer, results: answer.results.filter(r => r?.kind !== 'photos')} : answer;

/** Bridge's registry ops the site serves on its own origin with the member's session (notes, a thing's detail, its links and its house record:
 *  contract/things.md *Links*, *House record*), whatever the page's registry says; every other `bridge.*` op is a ROUTES one. */
const siteBridgeOp = op => op.startsWith('bridge.notes.') || op.startsWith('bridge.things.') && Object.hasOwn(backendDefinitions.bridge.ops, op.slice(7));

/** A resource path (`/v1/doc/7/page/2?w=1600`) as the site serves it (`/api/doc/7/page/2?w=1600`); null off the allowlist. */
export const webResource = path => resourcePath(path) ? path.replace(/^\/v1\//, '/api/') : null;

const PICKS = 'deck.picks', PREFS = 'deck.prefs', MAX_PICKS = 200;

/** win: the browser's window (fetch, open, navigator, localStorage, matchMedia); tests pass their own. `member`: who the page was
 *  served to (member.js; default the page's own), so the owner's codes are asked only for the owner. */
export function webHost(win = globalThis, {backends = {}, member = pageMember(win)} = {}) {
  const events = emitter(), life = pageLife(win);
  // a read's failure as the page sees it: `cancelled` once it is leaving (a body cut short by the navigation), else hostError's
  const failed = e => life.leaving ? new HostError('cancelled') : hostError(e);
  const caps = {codes: false, tower: false, owner: false};
  let codes = [], codeTimer;
  function pruneCodes() {
    clearTimeout(codeTimer);
    heldCodes();
    if (codes.length) {
      codeTimer = setTimeout(pruneCodes, Math.max(1, Math.min(...codes.map(row => Math.min(row.expires, row.at + CODE_MS))) - Date.now()));
      codeTimer.unref?.();
    }
  }
  let codeEvents, disposed = false, pageHidden = false;
  function closeCodeEvents() {
    const source = codeEvents;
    codeEvents = null;
    source?.close();
  }
  function subscribeCodes() {
    if (disposed || pageHidden || !codesAllowed || codeEvents || !win.EventSource) return;
    // Same-origin EventSource sends the site's session cookies and reconnects using the server's retry interval.
    const source = codeEvents = new win.EventSource('/api/events');
    source.addEventListener('code', event => {
      if (codeEvents !== source || !caps.codes || !codesAllowed) return;
      let data;
      try { data = JSON.parse(event.data); } catch { return; }
      if (typeof data?.id === 'string' && /^c_[A-Za-z0-9_-]+$/.test(data.id)) events.emit('beacon.code', {id: data.id});
    });
    source.addEventListener('open', () => {
      // Reconnects have no replay log: refresh codes that arrived while disconnected.
      if (codeEvents === source && caps.codes && codesAllowed) events.emit('codes.changed', {});
    });
  }
  const hideCodes = () => { pageHidden = true; closeCodeEvents(); };
  const showCodes = () => { pageHidden = false; subscribeCodes(); };
  win.addEventListener?.('pagehide', hideCodes);
  win.addEventListener?.('pageshow', showCodes);
  // Events contain only the identifier; values come from the authorized list.
  events.on('beacon.code', () => { if (caps.codes) events.emit('codes.changed', {}); });
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
    return request(target, method, body, signal, backends.bridge && !op.startsWith('money.') ? 'include' : 'same-origin', false, !backends.bridge && !op.startsWith('money.'), op === 'codes.list');
  }
  const flightplanCache = new Map();
  async function request(target, method, body, signal, credentials, strict = false, bridge = false, noStore = false) {
    const conditional = method === 'GET' && target.startsWith('/flightplan/api/');
    const cached = conditional ? flightplanCache.get(target) : null;
    let res;
    try {
      res = await life.fetch(target, {method, ...(noStore ? {cache: 'no-store'} : {}), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS), credentials, redirect: 'error', ...(body ? {body: JSON.stringify(body)} : {}),
        headers: {accept: 'application/json', ...(cached ? {'If-None-Match': cached.etag} : {}), ...(bridge ? {'X-Deck-Surface': 'web'} : {}), ...(body ? {'content-type': 'application/json'} : {})}});
    } catch (e) { throw failed(e); }
    if (res.status === 304 && cached) return cached.answer;
    // a write with nothing to say (Habitat's DELETE /api/zones/<id>)
    if (res.status === 204) return null;
    const answer = await res.json().catch(e => {
      // an abort (the caller's, the page leaving) or the time limit while the body still came: that, never "invalid JSON"
      if (life.leaving || cancelled(e) || e?.name === 'TimeoutError') throw failed(e);
      if (strict) throw new HostError('http', 'invalid JSON', res.status);
      return {};
    });
    const retryHeader = res.headers?.get?.('retry-after');
    const retry = Number(retryHeader) || (retryHeader ? Math.max(0, (Date.parse(retryHeader) - Date.now()) / 1000) : 0);
    if (!res.ok) {
      // a registry backend's own words stay out of the error (strict), but for its one known state: starting up (503 `warming`)
      const warming = res.status === 503 && answer?.error === 'warming';
      const error = new HostError('http', strict ? (warming ? 'warming' : `HTTP ${res.status}`) : answer.error || `HTTP ${res.status}`, res.status);
      // a backend's field checks (bridge's 400 {error: "invalid", fields: {path: message}}) are its words for each field the user
      // typed, shown beside it: the one body a strict read keeps
      if (res.status === 400 && answer?.error === 'invalid' && answer.fields && typeof answer.fields === 'object')
        error.fields = Object.fromEntries(Object.entries(answer.fields).filter(([k, m]) => typeof m === 'string' && k.length <= 200).map(([k, m]) => [k, m.slice(0, 300)]));
      if (retry > 0) error.retryAfter = retry;
      // any other refused write's field errors (Habitat's 400 {fields: {name: why}}): the form shows each beside its field
      const fields = !error.fields && res.status === 400 && answer?.fields;
      if (fields && typeof fields === 'object' && !Array.isArray(fields))
        error.fields = Object.fromEntries(Object.entries(fields).filter(([, why]) => typeof why === 'string').map(([k, why]) => [k, why.slice(0, 200)]));
      // whom a face is linked to (bridge.faceLink's 409), so the page can offer to move it
      if (!strict && answer?.holder?.id != null) error.holder = {id: String(answer.holder.id), name: answer.holder.name ?? null};
      throw error;
    }
    const etag = res.headers?.get?.('etag');
    if (conditional && etag) { if (flightplanCache.size >= 100) flightplanCache.delete(flightplanCache.keys().next().value); flightplanCache.set(target, {etag, answer}); }
    if (retry > 0 && answer && typeof answer === 'object' && !Array.isArray(answer)) answer.retryAfter = retry;
    return answer;
  }
  // Habitat's state stream (`habitat.stream`, GET on Deck's origin; `query.patterns` the entity globs): one socket with the
  // session's cookies; its changes are `habitat.state` events, its being open or lost `habitat.stream`. Closed, it reconnects
  // (1 s, doubling to 30 s). A second call replaces the first.
  const socketStream = habitatStream({openSocket: url => new win.WebSocket(url), emit: events.emit, subscribe: false});
  function stream(args, signal) {
    const route = backendRoute(backends, 'habitat.stream', args, {web: true});
    return socketStream.open({...route, url: new URL(route.url, win.location.origin).href}, args, signal);
  }
  async function backend(op, args, signal) {
    if (op === 'habitat.stream') return stream(args, signal);
    // Browser events supply the gesture; never accept evidence from op args.
    const bridgeConfig = siteBridgeOp(op) ? {...backends, bridge: {origin: backends.bridge?.origin ?? win.location.origin, scopes: ['bridge:find', 'bridge:act', 'bridge:notes-write'], ops: backendDefinitions.bridge.ops}} : backends;
    const route = backendRoute(bridgeConfig, op, args, {web: true, gesture: !!win.navigator?.userActivation?.isActive});
    // Camera media (contract/house.md *Camera wall*): Deck's own origin only, so the page's CSP stays 'self'. A frame as an object
    // URL; a live socket as its URL, which the page's WebSocket opens.
    const media = op === 'habitat.snapshot' || op === 'habitat.live';
    if (media && (route.method !== 'GET' || new URL(route.url, win.location.origin).origin !== win.location.origin))
      throw new HostError('refused', 'camera media require Deck’s own origin');
    if (op === 'habitat.live') {
      const u = new URL(route.url, win.location.origin);
      u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
      return {url: u.href};
    }
    if (op === 'habitat.snapshot') {
      let res;
      try { res = await life.fetch(route.url, {signal, credentials: 'same-origin', redirect: 'error', cache: 'no-store'}); }
      catch (e) { throw failed(e); }
      if (!res.ok) throw new HostError('http', `HTTP ${res.status}`, res.status);
      if (res.headers.get('content-type')?.split(';')[0] !== 'image/jpeg') throw new HostError('http', 'invalid snapshot');
      let frame;
      try { frame = await res.blob(); } catch (e) { throw failed(e); }
      return {url: URL.createObjectURL(frame)};
    }
    return request(route.url, route.method, route.body, signal, route.url.startsWith('/') ? 'same-origin' : 'include', true);
  }
  const houseActions = houseActionOps((op, args, options) => backend(op, args, options?.signal));
  let codesAllowed = false, codesLoading = null;
  // One read at a time for the page's mounts, which each ask env.get as they start (a caller's own signal reads alone).
  function loadCodes(signal) {
    if (signal) return readCodes(signal);
    codesLoading ??= readCodes().finally(() => { codesLoading = null; });
    return codesLoading;
  }
  async function readCodes(signal) {
    codes = [];
    clearTimeout(codeTimer);
    codesAllowed = false;
    try {
      const res = await life.fetch('/api/codes', {method: 'GET', credentials: 'same-origin', redirect: 'error',
        cache: 'no-store', headers: {accept: 'application/json', 'X-Deck-Surface': 'web'},
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]) : AbortSignal.timeout(REQUEST_TIMEOUT_MS)});
      if (res.status !== 200) throw new HostError('http', `HTTP ${res.status}`, res.status);
      const answer = await res.json();
      if (!Array.isArray(answer?.codes)) throw new HostError('http', 'invalid codes response');
      codes = answer.codes.filter(c => c && typeof c.id === 'string' && typeof c.code === 'string')
        .map(c => ({id: c.id, code: c.code, from: typeof c.from === 'string' ? c.from : '',
          source: typeof c.source === 'string' ? c.source : null, service: typeof c.service === 'string' ? c.service : null,
          serviceBy: typeof c.serviceBy === 'string' ? c.serviceBy : null, at: Date.parse(c.at), expires: Date.parse(c.expires)}));
      codesAllowed = caps.codes = true;
      if (disposed) { codes = []; codesAllowed = caps.codes = false; }
      subscribeCodes();
      pruneCodes();
      return heldCodes();
    } catch (e) {
      codes = [];
      codesAllowed = caps.codes = false;
      closeCodeEvents();
      if (life.leaving || cancelled(e)) throw new HostError('cancelled');
      throw new HostError('refused', 'codes unavailable', e.status);
    }
  }
  function heldCodes() {
    const now = Date.now();
    codes = codes.filter(c => Number.isFinite(c.at) && Number.isFinite(c.expires) && c.at <= now && now < Math.min(c.expires, c.at + CODE_MS))
      .sort((a, b) => b.at - a.at);
    return {codes: codes.map(({expires, ...c}) => c)};
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
    /** Who the page was served to (member.js), for `memberCan`: a page offers no write its member is refused. */
    member,
    dispose() {
      disposed = true;
      closeCodeEvents();
      clearTimeout(codeTimer);
      codes = [];
      codesAllowed = caps.codes = false;
      win.removeEventListener?.('pagehide', hideCodes);
      win.removeEventListener?.('pageshow', showCodes);
    },
    /** The registry's backend names (the nav this host can offer). */
    backends: Object.keys(backends),
    /** Who the page was served to (member.js): what they may do here (`memberCan`), so a page offers no write bridge refuses them. */
    member,
    caps: Object.assign(caps, {clusters: true, recent: false, transfers: false, actions: true, clipboard: true, files: false, drag: false, menus: false, window: false, telemetry: false, picks: true, browse: true, usage: true, corrections: true, texts: true, needs: true, money: true, ranking: true, expiring: true, obligations: true}),
    async call(op, args = {}, {signal, onWarming} = {}) {
      if (signal?.aborted) throw new HostError('cancelled');
      if (op === 'env.get') {
        if (memberCan(member, 'codes')) try { await loadCodes(signal); } catch { /* Denial and failures keep owner codes disabled. */ }
        // The owner-session check also opens the owner's Tower reads (AI plans, Fleet) and identity review (`owner`: People's duplicates).
        this.caps.codes = this.caps.tower = this.caps.owner = codesAllowed;
        return {...local[op](), caps: {...this.caps}};
      }
      if (op === 'codes.list' || op === 'codes.copy') {
        if (!codesAllowed) throw new HostError('unsupported');
        if (op === 'codes.list') {
          try { return await loadCodes(signal); }
          finally { this.caps.codes = codesAllowed; }
        }
        const code = heldCodes().codes.find(c => c.id === args.id);
        if (!code) throw new HostError('refused', 'code unavailable');
        try { await win.navigator.clipboard.writeText(code.code); }
        catch { throw new HostError('refused', 'clipboard unavailable'); }
        return null;
      }
      if (op === 'habitat.actions' || op === 'habitat.top' || op === 'habitat.run') {
        if (!this.caps.actions) throw new HostError('unsupported');
        return houseActions(op, args, {signal});
      }
      if (op.startsWith('money.')) {
        if (!this.caps.money || !MONEY_ARGS[op]) throw new HostError('unsupported');
        const why = invalid(MONEY_ARGS[op], args);
        if (why) throw new HostError('refused', why);
      }
      // Find's photos never reach a member who may not see them (the agent member's screenshots: member.js)
      if (op === 'bridge.find' && !memberCan(member, 'photos')) return untilWarm(() => bridge(op, args, signal), {signal, onWarming}).then(withoutPhotos);
      if (ROUTES[op]) return untilWarm(() => bridge(op, args, signal), {signal, onWarming});
      if (local[op]) return local[op](args);
      if (siteBridgeOp(op)) return backend(op, args, signal);
      if (/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+$/.test(op) && Object.hasOwn(backends, op.split('.')[0])) return backend(op, args, signal);
      throw new HostError('unsupported', `${op} is not on the site`);
    },
    resource(path, args, options) {
      if (path === 'habitat.snapshot' || path === 'habitat.live') return backend(path, args, options?.signal);
      const url = webResource(path);
      if (!url) throw new HostError('refused', 'not a resource path');
      return url;
    },
    on: events.on,
    /** The page's own events (a theme change), for the UI. */
    emit: events.emit,
  };
}
