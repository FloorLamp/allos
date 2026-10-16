// Trusted Deck config supplies destinations and fixed routes; callers supply data only.
import {HostError, invalid} from './host.js';

export const backendArgs = {type: 'object', additionalProperties: false, properties: {query: {type: 'object'}, body: {type: 'object'}}};
const name = /^[a-z][a-z0-9-]*$/;
const base = value => {
  try {
    const u = new URL(value);
    return !u.username && !u.password && u.pathname === '/' && !u.search && !u.hash &&
      (u.protocol === 'https:' || u.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)) ? u.origin : null;
  } catch { return null; }
};

export function backendRoute(backends, op, args = {}, {web = false, gesture = false} = {}) {
  const parts = op.split('.');
  if (parts.length !== 2 || !parts.every(p => name.test(p))) throw new HostError('unsupported', 'unknown backend operation');
  const [backend, operation] = parts;
  const entry = Object.hasOwn(backends, backend) && backends[backend];
  if (!entry && !['bridge', 'purser', 'rover', 'allos', 'habitat'].includes(backend)) throw new HostError('unsupported', 'unknown backend operation');
  if (!entry) throw new HostError('not-set-up', `${backend}: not configured`);
  const route = entry.ops && Object.hasOwn(entry.ops, operation) && entry.ops[operation];
  if (!route) throw new HostError('unsupported', `${op}: not configured`);
  const url = base(web ? entry.origin : entry.baseUrl);
  if (!url || !Array.isArray(entry.scopes) || entry.scopes.some(s => typeof s !== 'string' || !s.startsWith(`${backend}:`)) ||
      typeof route.scope !== 'string' || !route.scope.startsWith(`${backend}:`) || !entry.scopes.includes(route.scope))
    throw new HostError('not-set-up', `${backend}: invalid destination or scopes`);
  if (!['GET', 'POST'].includes(route.method) || typeof route.path !== 'string' ||
      !/^\/v1\/(?:[A-Za-z0-9_-]+|\{[a-z]+\})(?:\/(?:[A-Za-z0-9_-]+|\{[a-z]+\}))*$/.test(route.path))
    throw new HostError('not-set-up', `${op}: invalid route`);
  const why = invalid(backendArgs, args);
  if (why) throw new HostError('refused', why);
  if (route.method === 'GET' && args.body != null) throw new HostError('refused', 'GET has no body');
  if (route.method !== 'GET' && !gesture) throw new HostError('refused', `${op} needs a key or click in Deck first`);
  // Fill path parameters from query; shared account ids allow punctuation and are encoded as one segment.
  const params = {...args.query};
  const filled = route.path.replace(/\{([a-z]+)\}/g, (_, k) => {
    const v = params[k];
    delete params[k];
    if (typeof v !== 'string' || !(k === 'id' ? /^[a-z0-9][a-z0-9:._@-]{0,199}$/ : /^[A-Za-z0-9_-]+$/).test(v)) throw new HostError('refused', `${op}: ${k} is not a path segment`);
    return encodeURIComponent(v);
  });
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (!['string', 'number', 'boolean'].includes(typeof v) || typeof v === 'number' && !Number.isFinite(v)) throw new HostError('refused', 'query values must be scalar');
    query.set(k, String(v));
  }
  const path = web ? filled.replace(/^\/v1\//, '/api/') : filled;
  // A read the web twin takes as a same-origin JSON POST (allos's /api/ask: its cookie path refuses cross-site requests only on
  // non-GET, FloorLamp/allos#6089): the query becomes the body. Still a read, so no gesture.
  if (web && route.webPost) return {url: url + path, method: 'POST', body: Object.fromEntries(query)};
  const suffix = query.size ? `?${query}` : '';
  return {url: url + path + suffix, method: route.method, body: args.body};
}

// allos docs/device-api.md. Destinations and device grants remain trusted host config.
export const ALLOS_OPS = Object.fromEntries([
  ['accounts', 'GET', '/v1/accounts', 'read'],
  ['me', 'GET', '/v1/me', 'read'], ['profiles', 'GET', '/v1/profiles', 'read'],
  ['find', 'GET', '/v1/find', 'read'], ['record', 'GET', '/v1/record', 'read'],
  ['ask', 'GET', '/v1/ask', 'ask'], ['board', 'GET', '/v1/board', 'read'],
  ['dose', 'POST', '/v1/board/{dose}', 'log'], ['readings', 'GET', '/v1/readings', 'read'],
  ['log-reading', 'POST', '/v1/readings', 'log'], ['labs', 'GET', '/v1/labs', 'read'],
].map(([name, method, path, scope]) => [name, {method, path, scope: `allos:${scope}`, ...(name === 'ask' ? {webPost: true} : {})}]));
