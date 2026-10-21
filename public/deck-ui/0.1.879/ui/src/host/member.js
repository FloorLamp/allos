// Who a page was served to, and what that member may read and do (spaceport boarding/README.md *Members*, *The agent member*). Deck's
// own pages carry the request's trusted member (`<meta name="deck-member">` {id, name, role}: `owner`, `member`, or `agent`, the
// read-only agent member), so no host asks a backend for what the member is refused (the owner's one-time codes, Health, writes)
// only to fail on every load. A page that names nobody (another host's) leaves it unknown: its hosts ask as before.

/** The page's member {id, name, role}; null when the page was served to nobody (a House kiosk on the family network); undefined when
 *  the page does not say. */
export function pageMember(win = globalThis) {
  const meta = win.document?.querySelector?.('meta[name="deck-member"]');
  if (!meta) return undefined;
  try {
    const m = JSON.parse(meta.content);
    if (m === null) return null;
    return m && typeof m.id === 'string' && ['owner', 'member', 'agent'].includes(m.role) ? {id: m.id, name: typeof m.name === 'string' ? m.name : m.id, role: m.role} : undefined;
  } catch { return undefined; }
}

// codes: bridge's one-time codes and their events, the owner's own session only (never the agent member's); health: allos takes
// the owner and the agent member (allos lib/auth.ts, boarding's /owner); write: every backend refuses the agent member's writes;
// photos: Find's photos (bridge's `bridge:private` reads, CONTRACT.md *Find photos*), members only, never the agent member's.
const CAN = {codes: role => role === 'owner', health: role => role === 'owner' || role === 'agent', write: role => role !== 'agent',
  photos: role => role !== 'agent'};

/** May `member` (pageMember's answer) do `what` (codes, health, write, photos)? Unknown members may: the backend decides. */
export const memberCan = (member, what) => member === undefined || !!member && CAN[what](member.role);
