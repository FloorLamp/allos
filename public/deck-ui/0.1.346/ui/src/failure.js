// Shared, content-free failure copy. Never expose a backend response or exception message.
export const backendPage = backend => ({bridge: 'https://deck.wang.team/', purser: 'https://purser.wang.team/',
  rover: 'https://deck.wang.team/accounts', allos: 'https://allos.wang.team/deck/health', Habitat: 'https://habitat.wang.team/',
  habitat: 'https://habitat.wang.team/', Hangar: 'https://hangar.wang.team/'}[backend.split(' ')[0]] ?? null);

export function describeFailure(backend, error, {retryIn = null, device = false} = {}) {
  const status = error?.status, code = error?.code;
  const reason = status === 401 ? 'signed out' : status === 403 ? 'forbidden' : status === 404 ? 'not found'
    : status === 408 || status === 504 || code === 'timeout' || error?.name === 'TimeoutError' ? 'timeout'
    : status === 429 ? 'too many requests' : status >= 500 ? 'server error'
    : code === 'not-set-up' ? 'not set up' : code === 'unsupported' ? 'not supported here'
    : code === 'refused' ? 'action refused; use a key or click to retry' : code === 'cancelled' || error?.name === 'AbortError' ? 'cancelled'
    : code === 'unreachable' || error instanceof TypeError ? 'offline' : status ? `HTTP ${status}` : 'request failed';
  const action = status === 401 ? 'Re-enroll' : code === 'not-set-up' ? 'Settings' : `Open ${backend}`;
  const page = backendPage(backend);
  const site = new URL(page ?? 'https://deck.wang.team/');
  // Only boarding member sites serve this route; other backends recover through Deck.
  const memberSite = ['deck.wang.team', 'purser.wang.team', 'habitat.wang.team'].includes(site.hostname);
  const signIn = memberSite ? `${site.origin}/boarding/sign-in?to=${encodeURIComponent(site.pathname)}`
    : 'https://deck.wang.team/boarding/sign-in?to=%2F';
  const url = status === 401 ? device
    ? 'https://github.com/FloorLamp/spaceport/blob/main/deck/README.md#re-enroll-a-device'
    : signIn : page;
  if (status === 401) return {code, status, backend, reason, action, url,
    message: `${backend}: signed out. Your credential may have expired or been revoked. Re-enroll this device${device ? ' with a replacement boarding credential' : ' with your passkey'}.`};
  return {code, status, backend, reason, action, url,
    message: `${backend}: ${reason}.${code === 'not-set-up' && device ? ' Configure this backend in Settings.' : ''}${retryIn == null ? '' : ` Retrying ${retryIn.startsWith('when ') ? '' : 'in '}${retryIn}.`}`};
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
