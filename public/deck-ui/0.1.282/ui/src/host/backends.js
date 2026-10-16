import {backendNames, backendDefinitions, routeGrammar} from './backend-registry.js';
// Trusted Deck config supplies destinations and fixed routes; callers supply data only.
import {HostError, invalid} from './host.js';

export const backendArgs = {type: 'object', additionalProperties: false, properties: {query: {type: 'object'}, body: {type: 'object'}}};
const name = /^[a-z][a-z0-9-]*$/;
const [routePath, idParameter, pathParameter] = [routeGrammar.path, routeGrammar.id, routeGrammar.segment].map(p => new RegExp(p));
const base = value => {
  try {
    const u = new URL(value);
    return !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash &&
      (u.protocol === 'https:' || u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) ? u.origin : null;
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
  const url = base(web ? entry.origin : entry.baseUrl);
  if (!url || !Array.isArray(entry.scopes) || entry.scopes.some(s => typeof s !== 'string' || !s.startsWith(`${backend}:`)) ||
      typeof route.scope !== 'string' || !route.scope.startsWith(`${backend}:`) || !entry.scopes.includes(route.scope))
    throw new HostError('not-set-up', `${backend}: invalid destination or scopes`);
  // PATCH: a write as POST is (body, gesture), for backends that change an item where it is (flightplan's PATCH /v1/items/<id>)
  if (!routeGrammar.methods.includes(route.method) || typeof route.path !== 'string' || !routePath.test(route.path))
    throw new HostError('not-set-up', `${op}: invalid route`);
  const why = invalid(backendArgs, args);
  if (why) throw new HostError('refused', why);
  if (route.method === 'GET' && args.body != null) throw new HostError('refused', 'GET has no body');
  if (route.method !== 'GET' && !gesture) throw new HostError('refused', `${op} needs a key or click in Deck first`);
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
  const path = web ? filled.replace(/^\/v1\//, backend === 'habitat' && ['entities', 'states', 'state', 'stream', 'rules', 'act'].includes(operation) && !filled.startsWith('/v1/house/') ? '/api/house/' : '/api/') : filled;
  // A read the web twin takes as a same-origin JSON POST (allos's /api/ask: its cookie path refuses cross-site requests only on
  // non-GET, FloorLamp/allos#6089): the query becomes the body. Still a read, so no gesture.
  if (web && route.webPost) return {url: url + path, method: 'POST', body: Object.fromEntries(query)};
  const suffix = query.size ? `?${query}` : '';
  return {url: url + path + suffix, method: route.method, body: args.body};
}

// allos docs/device-api.md; destinations and device grants remain trusted host config.
export const ALLOS_OPS = backendDefinitions.allos.ops;

// Rover CONTRACT.md; destinations and grants remain trusted host config.
export const ROVER_OPS = backendDefinitions.rover.ops;
