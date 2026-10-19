// Shared, content-free failure copy. Never expose a backend response or exception message.
export const backendPage = backend => ({bridge: 'https://deck.wang.team/', purser: 'https://deck.wang.team/money',
  rover: 'https://deck.wang.team/accounts', allos: 'https://deck.wang.team/health', habitat: 'https://deck.wang.team/house',
  flightplan: 'https://deck.wang.team/flightplan', hangar: 'https://deck.wang.team/'}[backend.toLowerCase().split(' ')[0]] ?? null);

export function failurePage(backend) {
  const [name, ...context] = backend.split(' ');
  const label = {bridge: 'Find', purser: 'Money', rover: 'Sign-ins', allos: 'Health', habitat: 'House', flightplan: 'Flightplan', hangar: 'Recent'}[name.toLowerCase()];
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
  if (status === 401) return {code, status, backend, reason, state, action, url,
    message: device ? `${label} isn’t connected on this device. Reconnect it to continue.`
      : `Sign in to see ${failurePage(backend)}`};
  if (status === 403 && !device && failurePage(backend) !== backend) return {code, status, backend, reason, state, action: null, url: null,
    message: `${failurePage(backend)} is owner-only.`};
  const explanation = {
    forbidden: 'You don’t have permission to do that.', 'not found': 'The requested information couldn’t be found.',
    timeout: 'This is taking longer than expected. Try again.', 'too many requests': 'Please wait a moment and try again.',
    'starting up': 'Starting up. Please try again shortly.', 'server error': 'Temporarily unavailable. Please try again shortly.',
    'not set up': 'Not connected yet.', 'not supported here': 'This action isn’t available here.',
    'action refused; use a key or click to retry': 'Choose the action again to continue.', cancelled: 'The request was cancelled.',
    offline: 'Couldn’t connect. Check your connection and try again.',
  }[reason] ?? 'The request couldn’t be completed. Please try again.';
  return {code, status, backend, reason, state, action, url,
    message: `${label}: ${explanation}${retryIn == null ? '' : ` Retrying ${retryIn.startsWith('when ') ? '' : 'in '}${retryIn}.`}`};
}

// One backend can fail in several concurrent palette loads; keep one notice and retry them together.
export function paletteFailures(c) {
  const failures = [...Object.values(c.backgroundFailures)];
  for (const kind of ['codes', 'targets']) if (c[`${kind}Error`]) failures.push({
    backend: kind === 'codes' ? 'bridge' : 'Hangar', error: c[`${kind}Error`], retry: () => c.retryList(kind)});
  const grouped = new Map();
  for (const f of failures) {
    const group = grouped.get(f.backend) ?? [];
    group.push(f); grouped.set(f.backend, group);
  }
  return [...grouped.values()].map(group => ({...(group.find(f => f.error?.code === 'not-set-up') ?? group[0]),
    retry: () => group.forEach(f => f.retry?.())}));
}
