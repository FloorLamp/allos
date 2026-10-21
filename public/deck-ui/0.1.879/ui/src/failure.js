// Shared, content-free failure copy. Never expose a backend response or exception message.
export const backendPage = backend => ({bridge: 'https://deck.wang.team/', purser: 'https://deck.wang.team/money',
  rover: 'https://deck.wang.team/accounts', allos: 'https://deck.wang.team/health', habitat: 'https://deck.wang.team/house',
  flightplan: 'https://deck.wang.team/flightplan', hangar: 'https://deck.wang.team/'}[backend.toLowerCase().split(' ')[0]] ?? null);

// A Library page (People, Texts, …) is what bridge serves on it: its failures say that page's name, never "Find" (`setFailurePage`,
// once per document by the collection page's mount).
let libraryPage = null;
export const setFailurePage = name => { libraryPage = name ?? null; };
export function failurePage(backend) {
  const [name, ...context] = backend.split(' ');
  const label = {bridge: libraryPage ?? 'Find', purser: 'Money', rover: 'Sign-ins', allos: 'Health', habitat: 'House', flightplan: 'Flightplan', hangar: 'Recent'}[name.toLowerCase()];
  return label ? [label, ...context].join(' ') : backend;
}
export function webSignIn(href = globalThis.location?.href ?? 'https://deck.wang.team/') {
  const page = new URL(href);
  return `${page.origin}/boarding/sign-in?to=${encodeURIComponent(page.pathname + page.search + page.hash)}`;
}

export function describeFailure(backend, error, {retryIn = null, device = false} = {}) {
  const status = error?.status, code = error?.code;
  const reason = status === 401 ? 'signed out' : status === 403 ? 'forbidden' : status === 404 ? 'not found'
    : status === 408 || status === 504 || code === 'timeout' || error?.name === 'TimeoutError' ? 'timeout'
    : status === 429 ? 'too many requests' : status === 503 && /warming/.test(String(error?.message ?? '')) ? 'starting up' : status >= 500 ? 'server error'
    : code === 'not-set-up' ? 'not set up' : code === 'unsupported' ? 'not supported here'
    : code === 'refused' ? 'action refused; use a key or click to retry' : code === 'cancelled' || error?.name === 'AbortError' ? 'cancelled'
    : code === 'unreachable' || error instanceof TypeError ? 'offline' : status ? `HTTP ${status}` : 'request failed';
  const state = reason === 'signed out' ? 'signed out' : reason === 'starting up' ? 'warming' : 'error';
  const label = failurePage(backend);
  const action = status === 401 ? device ? 'Reconnect device' : 'Sign in' : `Open ${label}`;
  const page = backendPage(backend);
  const url = status === 401 ? device
    ? 'https://github.com/FloorLamp/spaceport/blob/main/deck/README.md#re-enroll-a-device'
    : webSignIn() : page;
  if (status === 401) {
    const message = device ? `${label} isn’t connected on this device. Reconnect it to continue.` : `Sign in to see ${failurePage(backend)}`;
    return {code, status, backend, reason, state, action, url, message, detail: message};
  }
  if (status === 403 && !device && failurePage(backend) !== backend) return {code, status, backend, reason, state, action: null, url: null,
    message: `${failurePage(backend)} is owner-only.`, detail: `${failurePage(backend)} is owner-only.`};
  const explanation = {
    forbidden: 'You don’t have permission to do that.', 'not found': 'The requested information couldn’t be found.',
    timeout: 'This is taking longer than expected. Try again.', 'too many requests': 'Please wait a moment and try again.',
    'starting up': 'Starting up. Please try again shortly.', 'server error': 'Temporarily unavailable. Please try again shortly.',
    'not set up': 'Not connected yet.', 'not supported here': 'This action isn’t available here.',
    'action refused; use a key or click to retry': 'Choose the action again to continue.', cancelled: 'The request was cancelled.',
    offline: 'Couldn’t connect. Check your connection and try again.',
  }[reason] ?? 'The request couldn’t be completed. Please try again.';
  const detail = `${explanation}${retryIn == null ? '' : ` Retrying ${retryIn.startsWith('when ') ? '' : 'in '}${retryIn}.`}`;
  // `detail`: the sentence alone, where a title or heading already names the service
  return {code, status, backend, reason, state, action, url, detail, message: `${label}: ${detail}`};
}

// What a query names when it is about a source's own things (its page's name, then its words): a failed source the query is not about
// is a quiet line under Find's results, never a block over them (paletteQuiet).
const SUBJECTS = {
  habitat: /\b(house|lights?|lamps?|locks?|unlock|doors?|garage|gates?|shades?|blinds?|curtains?|fans?|thermostats?|heat(ing)?|cool(ing)?|ac|switch(es)?|scenes?|cameras?|rooms?|outlets?|plugs?)\b/i,
  flightplan: /\b(flightplan|todos?|tasks?|needs?|items?|epics?|board)\b/i,
  hangar: /\b(recent|send|sent|receive|transfers?|share)\b/i,
  bridge: /\b(codes?|otp|verification)\b/i,
  allos: /\b(health|doses?|meds?|medications?|labs?|readings?)\b/i,
  purser: /\b(money|accounts?|balances?|transactions?|spending|budget)\b/i,
  rover: /\b(sign[- ]?ins?|logins?|passwords?)\b/i,
};
/** Whether `query` is about `backend`'s own things (House for `front door`, Flightplan for `todo`). */
export function aboutBackend(backend, query) {
  const name = String(backend ?? '').toLowerCase().split(' ')[0], q = String(query ?? '');
  const label = failurePage(backend).split(' ')[0];
  return !!q.trim() && (new RegExp(`\\b${label.replace(/[^\w]/g, '')}\\b`, 'i').test(q) || !!SUBJECTS[name]?.test(q));
}
/** Find's failures split for a query (`results`: it found something): `quiet` the plain errors of sources the query is not about, one
 *  line under the results; `loud` the rest (a signed-out page, a source not set up, one starting up, the query's own source, no results),
 *  their blocks above them. */
export function paletteQuiet(failures, {query, results, host}) {
  const quiet = f => results && !aboutBackend(f.backend, query) && f.error?.code !== 'not-set-up' && !(host?.kind !== 'shell' && f.error?.status === 401)
    && (f.error?.state ?? describeFailure(f.backend, f.error).state) === 'error';
  return {quiet: failures.filter(quiet), loud: failures.filter(f => !quiet(f))};
}

// One backend can fail in several concurrent palette loads; keep one notice and retry them together.
// `place`: where the landing shows it, in the place of the section it empties (`needs`: Needs you, `house`: House), else `list`;
// a backend never connected here is one device-wide line (`list`), never a section's.
export function paletteFailures(c) {
  const failures = Object.entries(c.backgroundFailures).map(([key, f]) => ({...f, place: f.error?.code === 'not-set-up' ? 'list' : key === 'actions' ? 'house' : key.endsWith('.needs') ? 'needs' : 'list'}));
  for (const kind of ['codes', 'targets']) if (c[`${kind}Error`]) failures.push({
    backend: kind === 'codes' ? 'bridge' : 'Hangar', error: c[`${kind}Error`], retry: () => c.retryList(kind), place: 'list'});
  const grouped = new Map();
  for (const f of failures) {
    const group = grouped.get(f.backend) ?? [];
    group.push(f); grouped.set(f.backend, group);
  }
  return [...grouped.values()].map(group => ({...(group.find(f => f.error?.code === 'not-set-up') ?? group[0]),
    retry: () => group.forEach(f => f.retry?.())}));
}
