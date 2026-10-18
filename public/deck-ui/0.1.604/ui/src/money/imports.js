// Faithful port of Purser imports.js at f334243; backend reads and browser services come from the mount context.
export async function mount(ctx) {
  const { $, api, mountMoneyPage, day, document, location, history, window, localStorage, sessionStorage, confirm, prompt, alert, setTimeout, clearTimeout } = ctx;
// Imports (`/imports`): each import with its counts (rows read, new, skipped), and the accounts they made with their spans, as Deck's
// rows. An account opens its transactions.

const { mountRows, host } = await mountMoneyPage();
const imp = mountRows($('imports'), host, { loading: 3 }), acc = mountRows($('accounts'), host, { loading: 6 });
const when = (iso) => (iso ? new Date(iso).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : 'unfinished');

try {
  const [{ imports }, { accounts }] = await Promise.all([api('/api/imports'), api('/api/facets')]);
  imp.update({ loading: 0, empty: { title: 'No imports yet', glyph: 'table' }, items: imports.map((i) => ({
    id: String(i.id), glyph: 'table', title: `${i.source === 'simplifi' ? `Simplifi export` : i.source} · ${i.rows_seen.toLocaleString()} rows`,
    sub: [when(i.finished_at), `${i.rows_new.toLocaleString()} new`, `${(i.rows_seen - i.rows_new).toLocaleString()} known`].join(' · '),
    notes: i.error ? [{ text: i.error, tone: 'warn' }] : [],
  })) });
  acc.update({ loading: 0, empty: { title: 'No accounts yet', glyph: 'statement' }, items: accounts.map((a) => ({
    id: String(a.id), glyph: 'statement', title: a.name, href: `/?account=${a.id}`,
    sub: a.n ? `${day(a.first)} – ${day(a.last)}` : 'no transactions', badge: { text: a.n.toLocaleString() },
  })) });
} catch (e) {
  imp.update({ loading: 0, error: { title: 'Could not load imports', line: e.message } });
  acc.update({ loading: 0, items: [] });
}

}
