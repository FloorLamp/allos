/** How long a one-time code stays in Codes after it came (SPEC.md, *Codes*): the hosts drop it then too. */
export const CODE_MS = 15 * 60_000;
/** The codes still within CODE_MS at `now`, newest first (a host's codes.list or codes.changed list, anything odd left out). */
export const liveCodes = (list, now) => (Array.isArray(list) ? list : [])
  .filter(c => c && typeof c.id === 'string' && typeof c.code === 'string' && Number.isFinite(c.at) && now - c.at < CODE_MS)
  .map(c => ({id: c.id, code: c.code, from: typeof c.from === 'string' ? c.from : '', at: c.at}))
  .sort((a, b) => b.at - a.at);

