import {backendNames, backendDefinitions, routeGrammar} from './backend-registry.js';
// Trusted Deck config supplies destinations and fixed routes; callers supply data only.
import {HostError, invalid} from './host.js';
import {memberCan} from './member.js';

export const backendArgs = {type: 'object', additionalProperties: false, properties: {query: {type: 'object'}, body: {type: 'object'}}};
const name = /^[a-z][a-z0-9-]*$/;
const [routePath, idParameter, pathParameter] = [routeGrammar.path, routeGrammar.id, routeGrammar.segment].map(p => new RegExp(p));
const base = (value, web, nativePath) => {
  try {
    const u = new URL(value);
    const root = u.pathname === '/' && /^[a-z][a-z0-9+.-]*:\/\/[^/\\?#]+\/?$/i.test(value);
    const prefix = web ? (/^\/(?:[a-zA-Z0-9_-]+(?:\/[a-zA-Z0-9_-]+)*\/?)?$/.test(u.pathname) ? u.pathname.replace(/\/$/, '') : '')
      : nativePath && value === u.origin + nativePath && u.pathname === nativePath ? nativePath : '';
    return !u.username && !u.password && (web ? (value === u.origin || value === u.origin + u.pathname) && (u.pathname === '/' || prefix) : root || !!prefix) && !u.search && !u.hash &&
      (u.protocol === 'https:' || u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) ? u.origin + prefix : null;
  } catch { return null; }
};

export function backendRoute(backends, op, args = {}, {web = false, gesture = false} = {}) {
  if (op.endsWith('.need') && args != null && Object.hasOwn(args, 'id')) {
    if (Object.keys(args).some(k => k !== 'id') || typeof args.id !== 'string' || !/^[a-z0-9][a-z0-9:._@-]{0,199}$/.test(args.id))
      throw new HostError('refused', 'invalid need id');
    if (!gesture) throw new HostError('refused', 'need requires a click or key');
    const route = backendRoute(backends, op.replace(/\.need$/, '.needs'), {}, {web, gesture});
    return {...route, url: `${route.url}/${encodeURIComponent(args.id)}`, method: 'POST', body: {}};
  }
  const [backend, ...operationParts] = op.split('.');
  const operation = operationParts.join('.');
  const parts = [backend, ...operationParts];
  if (parts.length < 2 || !parts.every(p => name.test(p))) throw new HostError('unsupported', 'unknown backend operation');
  const entry = Object.hasOwn(backends, backend) && backends[backend];
  if (!entry && !backendNames.includes(backend)) throw new HostError('unsupported', 'unknown backend operation');
  if (!entry) throw new HostError('not-set-up', `${backend}: not configured`);
  const route = entry.ops && Object.hasOwn(entry.ops, operation) && entry.ops[operation];
  if (!route) throw new HostError('unsupported', `${op}: not configured`);
  const url = web && backendDefinitions[backend]?.webPath ? backendDefinitions[backend].webPath : base(web ? entry.origin : entry.baseUrl, web, backendDefinitions[backend]?.nativePath);
  if (!url || !Array.isArray(entry.scopes) || entry.scopes.some(s => typeof s !== 'string' || !s.startsWith(`${backend}:`)) ||
      typeof route.scope !== 'string' || !route.scope.startsWith(`${backend}:`) || !entry.scopes.includes(route.scope))
    throw new HostError('not-set-up', `${backend}: invalid destination or scopes`);
  // PATCH: a write as POST is (body, gesture), for backends that change an item where it is (flightplan's PATCH /v1/items/<id>)
  if (!routeGrammar.methods.includes(route.method) || typeof route.path !== 'string' || !routePath.test(route.path))
    throw new HostError('not-set-up', `${op}: invalid route`);
  const why = invalid(backendArgs, args);
  if (why) throw new HostError('refused', why);
  if (route.method === 'GET' && args.body != null) throw new HostError('refused', 'GET has no body');
  // Render telemetry runs without user input; keep the exception on its fixed endpoint and evidence shape.
  const readiness = op === 'habitat.tablet-readiness' && route.method === 'POST' && route.path === '/v1/tablet/readiness' &&
    args.query == null && args.body?.rendered === true && args.body?.stream_reconnected === true &&
    typeof args.body?.at === 'string' && Number.isFinite(Date.parse(args.body.at)) &&
    Object.keys(args.body).every(k => ['rendered', 'stream_reconnected', 'at'].includes(k));
  const noteSave = op === 'bridge.notes.save' && route.method === 'PUT' && route.path === '/v1/notes/{id}' && route.scope === 'bridge:notes-write';
  const noteTodo = route.method === 'POST' && route.scope === 'flightplan:write' &&
    (op === 'flightplan.notes.upsert' && route.path === '/v1/items' || op === 'flightplan.notes.done' && route.path === '/v1/items/{id}/done');
  if (route.method !== 'GET' && !gesture && !readiness && !noteSave && !noteTodo) throw new HostError('refused', `${op} needs a key or click in Deck first`);
  // Fill path parameters from query; shared account ids allow punctuation and are encoded as one segment.
  const params = {...args.query};
  let filled = route.path.replace(/\{([a-z]+)\}/g, (_, k) => {
    const v = params[k];
    delete params[k];
    if (typeof v !== 'string' || !(k === 'id' ? idParameter : pathParameter).test(v)) throw new HostError('refused', `${op}: ${k} is not a path segment`);
    return encodeURIComponent(v);
  });
  // Habitat's web history predates the device path and takes its entity in the query.
  if (web && backend === 'habitat' && operation === 'history' &&
      ['/v1/history/{id}', '/v1/house/history'].includes(route.path)) {
    filled = '/v1/house/history';
    params.entity_id = args.query?.id ?? args.query?.entity_id;
    delete params.id;
  }
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (!['string', 'number', 'boolean'].includes(typeof v) || typeof v === 'number' && !Number.isFinite(v)) throw new HostError('refused', 'query values must be scalar');
    query.set(k, String(v));
  }
  const path = web ? filled.replace(/^\/v1\//, backend === 'habitat' && ['entities', 'states', 'state', 'stream', 'rules', 'rule', 'shadowreport', 'act', 'settings', 'setting'].includes(operation) && !filled.startsWith('/v1/house/') ? '/api/house/' : '/api/') : filled;
  // A read the web twin takes as a same-origin JSON POST (allos's /api/ask: its cookie path refuses cross-site requests only on
  // non-GET, FloorLamp/allos#6089): the query becomes the body. Still a read, so no gesture.
  if (web && route.webPost) return {url: url + path, method: 'POST', body: Object.fromEntries(query)};
  const suffix = query.size ? `?${query}` : '';
  return {url: url + (web && backend === 'habitat' && operation === 'health' && path === '/healthz' ? '/api/house/health' : path) + suffix, method: route.method, body: args.body};
}

// allos docs/device-api.md; destinations and device grants remain trusted host config.
export const ALLOS_OPS = backendDefinitions.allos.ops;

// Rover CONTRACT.md; destinations and grants remain trusted host config.
export const ROVER_OPS = backendDefinitions.rover.ops;

// Shared browser configuration for Deck's pages. Public origins contain no grants or credentials.
// Keep the read-only account/Needs surface and Flightplan's session-protected mutations identical across hosts. `member` (member.js):
// a page's member is never offered Health it cannot read (allos answers 401).
export function deckBackendConfig(origins, {member} = {}) {
  const config = {};
  for (const backend of ['allos', 'purser', 'rover', 'habitat']) {
    if (backend === 'allos' && !memberCan(member, 'health')) continue;
    const origin = origins?.[backend];
    if (!base(origin, true) || new URL(origin).pathname !== '/')
      throw new HostError('not-set-up', `${backend}: invalid public origin`);
    const definition = backendDefinitions[backend];
    const names = backend === 'allos' ? Object.keys(definition.ops)
      : backend === 'purser' ? ['accounts', 'needs', 'merchants.resolve', 'txns'] : backend === 'habitat' ? ['accounts', 'needs', 'entities', 'states', 'state', 'act'] : ['accounts', 'needs'];
    const ops = Object.fromEntries(names.map(name => [name, definition.ops[name]]));
    // Habitat's existing browser twin exposes House needs with its read scope (habitat#85).
    if (backend === 'habitat') ops.needs = {...ops.needs, path: '/v1/house/needs', scope: ops.accounts.scope};
    config[backend] = {origin, scopes: backend === 'habitat' ? ['habitat:read', 'habitat:api'] : [definition.ops.accounts.scope], ops};
  }
  const ops = backendDefinitions.flightplan.ops;
  config.flightplan = {scopes: [...new Set(Object.values(ops).map(route => route.scope))], ops};
  return config;
}
