import {isoDay} from './format.js';
// What an identity paper asks of its holder, for Papers and Find's credential answers alike (contract/papers.md *Order*).

/** A current paper expiring within this many days needs action now. */
export const EXPIRING_DAYS = 90;
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
// An issuer's name compares; a masked or numbered scope is the paper's own identifier, which a renewal changes.
const issuer = scope => scope && !/[\d•]/.test(scope) ? scope.trim().toLowerCase() : null;
const sameScope = (a, b) => !issuer(a) || !issuer(b) || issuer(a) === issuer(b);

/** Each replaced paper's id → the id of the paper that replaced it. Bridge's `replacedBy` where the paper carries the field
 *  (null: not replaced); until bridge sends it (FP-1692), an expired paper whose holder, kind and scope have a current paper
 *  expiring later. */
export function replacements(papers) {
  const out = new Map();
  for (const p of papers) {
    if (p.replacedBy !== undefined) { if (p.replacedBy != null) out.set(p.id, p.replacedBy); continue; }
    if (p.state !== 'expired' || !p.expiry) continue;
    const newer = papers.find(q => q !== p && q.state === 'current' && q.person?.id === p.person?.id && q.kind === p.kind
      && sameScope(p.scope, q.scope) && (q.expiry ?? '') > p.expiry);
    if (newer) out.set(p.id, newer.id);
  }
  return out;
}

/** `expired` (not replaced) and `expiring` (current, within EXPIRING_DAYS) need action; then `current`, `unknown`, `replaced`. */
export function standingOf(p, replacedBy, today) {
  if (replacedBy) return 'replaced';
  if (p.state === 'expired') return 'expired';
  if (p.state !== 'current') return 'unknown';
  return p.expiry && p.expiry <= addDays(today, EXPIRING_DAYS) ? 'expiring' : 'current';
}
export const RANK = {expired: 0, expiring: 0, current: 1, unknown: 2, replaced: 3};
export const needsAction = p => RANK[p.standing] === 0;

/** Copies of `papers` with `replacedBy` (id or null) and `standing` resolved; `today` an ISO day (default the local one). */
export function withStanding(papers, {today = isoDay(new Date())} = {}) {
  const replaced = replacements(papers);
  return papers.map(p => { const replacedBy = replaced.get(p.id) ?? null; return {...p, replacedBy, standing: standingOf(p, replacedBy, today)}; });
}

/** Find's credential answers (bridge's rows carrying `paper`): each paper's standing resolved; what needs action first and the
 *  replaced last, in the places those rows hold, every other row where bridge put it. */
export function credentialAnswers(rows, opts) {
  const at = rows.flatMap((r, i) => r?.paper?.id != null ? [i] : []);
  if (!at.length) return rows;
  const papers = withStanding(at.map(i => ({...rows[i].paper, state: rows[i].state ?? rows[i].paper.state})), opts);
  const ranked = at.map((i, n) => ({...rows[i], paper: {...rows[i].paper, replacedBy: papers[n].replacedBy, standing: papers[n].standing}}))
    .sort((a, b) => RANK[a.paper.standing] - RANK[b.paper.standing]);
  const out = [...rows];
  at.forEach((i, n) => { out[i] = ranked[n]; });
  return out;
}
