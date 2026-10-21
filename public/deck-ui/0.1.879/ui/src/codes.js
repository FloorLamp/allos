/** How long a one-time code stays in Codes after it came (SPEC.md, *Codes*): the hosts drop it then too. */
export const CODE_MS = 15 * 60_000;
const str = v => (typeof v === 'string' && v.trim() ? v.trim() : null);
/** The codes still within CODE_MS at `now`, newest first (a host's codes.list or codes.changed list, anything odd left out). */
export const liveCodes = (list, now) => (Array.isArray(list) ? list : [])
  .filter(c => c && typeof c.id === 'string' && typeof c.code === 'string' && Number.isFinite(c.at) && now - c.at < CODE_MS)
  .map(c => ({id: c.id, code: c.code, from: typeof c.from === 'string' ? c.from : '', at: c.at,
    source: str(c.source), service: str(c.service), serviceBy: str(c.serviceBy)}))
  .sort((a, b) => b.at - a.at);

/** Each source as a code row names it and draws it (shared glyphs). */
const CHANNELS = {text: ['Text', 'chat'], mail: ['Email', 'mail'], whatsapp: ['WhatsApp', 'chat'], signal: ['Signal', 'chat']};

/** Where a code came from (SPEC.md, *Codes*): `line` "<service> · <channel>" (a text's service from bridge's short-code table, or
 *  none, adds "from <number>"), else "<from> · <channel>"; `glyph` its channel's. A host without the source shows the sender alone. */
export function codeOrigin(c) {
  const from = str(c?.from), service = str(c?.service), [channel, glyph] = CHANNELS[c?.source] ?? [null, 'key'];
  const who = service ?? from ?? (channel ? 'Unknown sender' : 'a text');
  const via = channel && c.source === 'text' && service && from && from !== service && c.serviceBy === 'table' ? `${channel} from ${from}` : channel;
  return {line: via ? `${who} · ${via}` : who, glyph};
}
