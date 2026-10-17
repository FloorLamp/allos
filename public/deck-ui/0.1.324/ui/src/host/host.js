// What every host shares (contract/README.md): the API version, error codes, caps, the resource allowlist, the URLs a host may open, an
// event emitter and the contract's args check (a JSON Schema subset; contract/host-contract.json). No DOM: the controller's tests
// run it under node.

export const HOST_API = 1;

/** Error codes (SPEC.md, *States*): bridge unreachable, an HTTP failure (`status`), no bridge token, an op this host lacks, a call
 *  the host refused (bad args, no recent input), a call cancelled by its signal. */
export const ERRORS = ['unreachable', 'http', 'not-set-up', 'unsupported', 'refused', 'cancelled'];

export class HostError extends Error {
  constructor(code, message = code, status = undefined) {
    super(message);
    this.name = 'HostError';
    this.code = ERRORS.includes(code) ? code : 'http';
    if (status !== undefined) this.status = status;
  }
}

/** A thrown value as a HostError (an abort is `cancelled`, a network failure `unreachable`). */
export function hostError(e) {
  if (e instanceof HostError) return e;
  if (e?.name === 'AbortError') return new HostError('cancelled');
  if (e?.code && ERRORS.includes(e.code)) return new HostError(e.code, e.message, e.status);
  return new HostError('unreachable', String(e?.message ?? e));
}

/** Caps (contract/README.md); `browse` is the site's filtered browse (bridge.facets, bridge.browse), `usage` a series' chart (bridge.usage),
 *  `corrections` the owner's corrections in the document pane (bridge.correct, bridge.matches), `texts` the Texts list (bridge.texts,
 *  bridge.textsPages, bridge.textsConversation) and `needs` what only the owner can fix (bridge.needs, bridge.need), each off on the
 *  shells unless env.get says; `money` is Purser’s read-only Money surface, also off until env.get enables it; the site supports `texts`. `codes` is the desktops' one-time codes (codes.list, codes.copy; SPEC.md
 *  *Codes*): never the site's. */
export const CAPS = ['recent', 'transfers', 'actions', 'clipboard', 'files', 'drag', 'menus', 'window', 'telemetry', 'picks', 'browse', 'usage', 'corrections', 'texts', 'needs', 'codes', 'money'];
export const SITE_CAPS = ['browse', 'usage', 'corrections', 'texts', 'needs', 'money'];

/** Telemetry names a host forwards (beacon CONTRACT.md, *App telemetry*); never a query, value or title. */
export const TELEMETRY = ['palette_open', 'find', 'ask', 'find_file', 'view', 'related', 'group', 'transfer'];

/** Resource paths a host serves (GET only; anything else refused): pages and video of a document, its attachments' and messages',
 *  an email's inline and proxied images, and (a shell's own) Recent's files. `[pattern, query keys, shell only]`. */
export const RESOURCES = [
  [/^\/v1\/thing-image\/[a-f0-9]{64}$/, [], false],
  [/^\/v1\/doc\/[0-9]+(\/message\/[A-Za-z0-9_.:@+=%-]{1,200})?(\/attachment\/[0-9]+(\/attachment\/[0-9]+)?)?\/(page\/[0-9]+|video)$/, ['w', 'v'], false],
  [/^\/v1\/doc\/[0-9]+\/message\/[A-Za-z0-9_.:@+=%-]{1,200}\/inline\/[0-9.]{1,64}$/, [], false],
  [/^\/v1\/doc\/[0-9]+\/image$/, ['u'], false],
  [/^\/v1\/texts\/[A-Za-z0-9_.:@+=%-]{1,200}\/message\/[A-Za-z0-9_.:@+=%-]{1,200}\/attachment\/[0-9]+(\/attachment\/[0-9]+)?\/(page\/[0-9]+|video)$/, ['w', 'v'], false],
  [/^\/local\/recent\/[A-Za-z0-9_-]{1,100}(\/thumb)?$/, [], true],
];

/** A resource path when the allowlist has it (its query keys only those allowed), else null. `shell`: the host serves Recent. */
export function resourcePath(path, {shell = false} = {}) {
  if (typeof path !== 'string' || path.length > 4000) return null;
  const at = path.indexOf('?'), p = at < 0 ? path : path.slice(0, at), q = at < 0 ? '' : path.slice(at + 1);
  const hit = RESOURCES.find(([re, , own]) => re.test(p) && (shell || !own));
  if (!hit) return null;
  const params = new URLSearchParams(q);
  for (const k of params.keys()) if (!hit[1].includes(k)) return null;
  return path;
}

/** A URL a host may hand to the browser: http(s), mailto and tel only. */
export const openable = url => typeof url === 'string' && /^(https?:\/\/|mailto:|tel:)/i.test(url) ? url : null;

/** on(event, fn) → unsubscribe; emit(event, data). */
export function emitter() {
  const fns = new Map();
  return {
    on(event, fn) {
      if (!fns.has(event)) fns.set(event, new Set());
      fns.get(event).add(fn);
      return () => fns.get(event)?.delete(fn);
    },
    emit(event, data) { for (const fn of fns.get(event) ?? []) fn(data); },
  };
}

/** The first way `value` breaks `schema` (contract/host-contract.json's subset), else null. */
export function invalid(schema, value, at = 'args') {
  if (!schema) return null;
  const type = v => v === null ? 'null' : Array.isArray(v) ? 'array' : Number.isInteger(v) ? 'integer' : typeof v;
  if (schema.enum && !schema.enum.includes(value)) return `${at}: not one of ${schema.enum.join(', ')}`;
  if (schema.type) {
    const types = [schema.type].flat(), t = type(value);
    if (!types.includes(t) && !(t === 'integer' && types.includes('number'))) return `${at}: ${t}, not ${types.join(' or ')}`;
  }
  if (typeof value === 'string') {
    if (schema.maxLength != null && value.length > schema.maxLength) return `${at}: longer than ${schema.maxLength}`;
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) return `${at}: does not match ${schema.pattern}`;
  }
  if (typeof value === 'number') {
    if (schema.minimum != null && value < schema.minimum) return `${at}: under ${schema.minimum}`;
    if (schema.maximum != null && value > schema.maximum) return `${at}: over ${schema.maximum}`;
  }
  if (Array.isArray(value)) {
    if (schema.maxItems != null && value.length > schema.maxItems) return `${at}: over ${schema.maxItems} items`;
    for (const [i, v] of value.entries()) { const e = invalid(schema.items, v, `${at}[${i}]`); if (e) return e; }
  }
  if (type(value) === 'object') {
    for (const k of schema.required ?? []) if (!(k in value)) return `${at}.${k}: missing`;
    for (const [k, v] of Object.entries(value)) {
      if (schema.properties?.[k]) { const e = invalid(schema.properties[k], v, `${at}.${k}`); if (e) return e; }
      else if (schema.additionalProperties === false) return `${at}.${k}: not allowed`;
    }
  }
  return null;
}
