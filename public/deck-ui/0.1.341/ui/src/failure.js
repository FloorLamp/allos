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
    message: `${backend}: signed out. Your credential may have expired or been revoked. Not retrying automatically. Re-enroll this device${device ? ' with a replacement boarding credential' : ' with your passkey'}.`};
  return {code, status, backend, reason, action, url,
    message: `${backend}: ${reason}. ${retryIn == null ? 'Not retrying automatically. Retry' : `Retrying ${retryIn.startsWith('when ') ? '' : 'in '}${retryIn}`}.`};
}
