// Faithful port of Purser page.js at f334243; backend reads and browser services come from the mount context.
export async function mount(ctx) {
  const { mountMoneyPage, $, api, deckUi, money, day, session: getSession, post, el, transactionActions, transactionContent, fixBar, focusTransactionRow, transactionRowKeys, document, location, history, window, localStorage, sessionStorage, confirm, prompt, alert, setTimeout, clearTimeout } = ctx;
// Transactions (`/`): search and filters (account, category, dates, amount by size) over the ledger, newest first, as Deck's rows
// (deck-ui mountRows): payee, date · account · category (a split's lines), the amount; notes for a transfer and why a row has its
// category (you, Simplifi, a rule). The owner picks rows (checkable rows) or uses the filter's rows to fix categories (fix.js); a
// row opens the shared drawer with its merchant link and report exclusion. The URL keeps the filters. No inline script (deck-ui's CSP).

const [{ mountRows, mountDrawer, money: moneyQuantity, dateSection, host }, { h }] = await Promise.all([mountMoneyPage(), deckUi('ui/vendor/preact.mjs')]);
const KEYS = ['q', 'account', 'category', 'from', 'to', 'min', 'max', 'merchant', 'sort', 'kind', 'preset'];
const PAGE = 100;
const params = new URLSearchParams(location.search);
for (const k of KEYS) $(k).value = params.get(k) ?? (k === 'sort' ? 'newest' : k === 'kind' ? 'spending' : '');

const drawerRoot = el('div');
document.body.append(drawerRoot);
const drawer = mountDrawer(drawerRoot, { open: false });
let drawerRequest = 0;
const detailURL = ctx.detailURL('txn', async (id) => {
  const request = ++drawerRequest;
  if (!id) { drawer.update({ open: false }); return; }
  try {
    const t = items.find(t => String(t.id) === id) ?? await api(`/api/txn/${Number(id)}`);
    if (request === drawerRequest) openTransaction(t);
  } catch (e) { if (request !== drawerRequest) return; drawer.update({open: true, title: 'Could not load transaction', children: h('p', {role: 'alert'}, e.message), onClose: () => detailURL.close()}); }
});
function openTransaction(t) {
  focusTransactionRow($('rows'), t.id);
  const request = ++drawerRequest;
  let saving = false, error = '', detail = null, closed = false, into = '', confirmDelete = false;
  const change = async (action, body) => {
    saving = true; error = ''; paint();
    try {
      await post(`/api/txn/${t.id}/${action}`, body);
      if (action === 'excluded') {
        t.tags = t.tags.filter((tag) => tag !== 'excluded');
        if (body.excluded) t.tags.push('excluded');
        if (detail) detail.tags = t.tags;
      } else {
        closed = true;
        if (request === drawerRequest) detailURL.close();
      }
      await load();
    } catch (e) { error = e.message; }
    saving = false; paint();
  };
  const paint = () => !closed && request === drawerRequest && drawer.update({ open: true, title: t.transfer ? `Transfer · ${t.transfer_accounts?.from ?? t.account.name} → ${t.transfer_accounts?.to ?? 'external'}` : t.merchant?.name || t.description || '(no payee)', sub: `${day(t.date)} · ${t.account.name}`,
    onClose: () => { closed = true; detailURL.close(); focusTransactionRow($('rows'), t.id); }, children: h('div', {},
      detail ? transactionContent(h, detail, { money, day }) : h('p', { role: 'status' }, 'Loading details…'),
      t.merchant ? h('button', { type: 'button', onClick: () => openMerchant(t) }, 'Merchant') : null,
      session.owner ? transactionActions(h, t, { money, day, saving, into, confirmDelete,
        candidates: items.filter((r) => r.id !== t.id),
        onInto: (value) => { into = value; paint(); },
        onConfirmDelete: (value) => { confirmDelete = value; paint(); },
        change }) : h('p', {}, t.tags.includes('excluded') ? 'Not in reports' : 'Included in reports'),
      h('p', { role: 'status' }, error)) });
  paint();
  api(`/api/txn/${t.id}`).then((result) => { detail = result; detail.tags = t.tags; }).catch((e) => { error = e.message; })
    .finally(() => { if (!closed && request === drawerRequest) paint(); });
}
async function openMerchant(t) {
  const request = ++drawerRequest;
  drawer.update({open: true, title: t.merchant.name, children: h('p', {role: 'status'}, 'Loading merchant…'), onClose: () => openTransaction(t)});
  try {
    const m = await api(`/api/merchant/${t.merchant.id}`);
    if (request !== drawerRequest) return;
    drawer.update({open: true, title: m.name, onClose: () => openTransaction(t), children: h('div', {},
      h('button', {type: 'button', onClick: () => openTransaction(t)}, 'Back to transaction'),
      h('p', {}, `Default: ${m.default.category?.name ?? 'Uncategorized'} · ${m.default.why}`),
      ...m.rules.map(r => h('p', {}, r.text)),
      h('a', {href: `/transactions?merchant=${m.id ?? t.merchant.id}`}, 'View transactions'))});
  } catch (e) { if (request === drawerRequest) drawer.update({children: h('p', {role: 'alert'}, e.message)}); }
}
const list = mountRows($('rows'), host, { loading: 8, onOpen: item => detailURL.open(item.id),
  sectionTotal: (rows) => moneyQuantity(rows.reduce((n, r) => n + r.quantity.value, 0)) });
transactionRowKeys($('rows'), item => detailURL.open(item.id));
let items = [], total = 0, seq = 0, bar = null;
const picked = new Set();

const row = (t) => ({
  id: String(t.id), glyph: null, section: ['newest', 'oldest'].includes($('sort').value) ? dateSection(t.date) : null, title: t.transfer ? `Transfer · ${t.transfer_accounts?.from ?? t.account.name} → ${t.transfer_accounts?.to ?? 'external'}` : t.merchant?.name || t.description || '(no payee)',
  sub: [t.lines ? `Split · ${t.lines} lines` : t.category?.name.replaceAll(':', ' › ') ?? 'Uncategorized', t.account.name].join(' · '),
  notes: [...(t.pending ? [{ text: 'pending', tone: 'warn' }] : []), ...(t.tags.includes('excluded') ? [{ text: 'excluded from reports' }] : []),
    ...(t.transfer ? [{ text: 'transfer pair' }] : t.tags.includes('external') ? [{ text: 'transfer, outside' }] : []),
    ...(t.why?.by ? [{ text: `${t.why.text}${t.category_source === 'rule' && t.confidence < 0.8 ? ', unsure' : ''}`, tone: t.category_source === 'rule' && t.confidence < 0.8 ? 'warn' : '' }] : [])],
  quantity: moneyQuantity(t.amount_cents / 100),
  href: `/transactions?${filters()}&txn=${t.id}`,
});

const draw = () => {
  syncSelection();
  syncSort();
  $('empty-clear').hidden = total !== 0;
  list.update({ loading: 0, error: null, items: items.map(row), checked: [...picked].map(String),
  empty: { title: 'No transactions', line: 'Nothing matches these filters.', glyph: 'receipt' } });
};

// what the bar acts on: the picked rows, else the filter's
function target() {
  if (picked.size) {
    const n = picked.size;
    return { spec: { txns: [...picked] }, label: `${n} picked`, scopes: [['this', n === 1 ? 'This one' : `These ${n}`], ['merchant', 'All from merchant'], ['future', 'This and future']] };
  }
  const f = filters();
  f.delete('sort');
  if (!f.size || !total) return null;
  return { spec: { filter: Object.fromEntries(f) }, label: `${total.toLocaleString()} matching`,
    scopes: [['this', `These ${total.toLocaleString()}`], ['merchant', 'All from their merchants'], ['future', 'Those and future']] };
}

function filters() {
  const p = new URLSearchParams();
  for (const k of KEYS) if ($(k).value.trim()) p.set(k, $(k).value.trim());
  return p;
}

async function load({ more = false } = {}) {
  const mine = ++seq, p = filters();
  if (!more) {
    const selected = new URLSearchParams(location.search).get('txn');
    if (selected) p.set('txn', selected);
    const to = p.size ? `/transactions?${p}` : '/transactions';
    if (to !== location.pathname + location.search) history.replaceState(null, '', to);
  }
  p.delete('txn');
  p.set('limit', PAGE);
  p.set('offset', more ? items.length : 0);
  try {
    const r = await api(`/api/txns?${p}`);
    if (mine !== seq) return;
    items = more ? [...items, ...r.items] : r.items;
    total = r.total;
    $('summary').textContent = `${total.toLocaleString()} ${total === 1 ? 'transaction' : 'transactions'} · net ${money(r.sum_cents)}`;
    draw();
    bar?.refresh();
    $('more').hidden = items.length >= total;
  } catch (e) {
    if (mine !== seq) return;
    $('empty-clear').hidden = true;
    list.update({ loading: 0, error: { title: 'Could not load transactions', line: e.message, action: 'Retry', onAction: () => load() } });
  }
}

function clearFilters() {
  clearTimeout(timer);
  for (const k of KEYS) $(k).value = k === 'sort' ? 'newest' : k === 'kind' ? 'spending' : '';
  syncRule();
  load();
}
let timer;
$('clear').addEventListener('click', clearFilters);
$('empty-clear').addEventListener('click', clearFilters);
$('filter-toggle').addEventListener('click', () => {
  const button = $('filter-toggle');
  button.setAttribute('aria-expanded', String(button.getAttribute('aria-expanded') !== 'true'));
});
function syncFilterCount() {
  const count = KEYS.filter((k) => k !== 'q' && $(k).value.trim() !==
    (k === 'kind' ? 'spending' : k === 'sort' ? 'newest' : '')).length;
  $('filter-toggle').textContent = `Filters (${count})`;
}
$('q').addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });
for (const k of KEYS.slice(1)) $(k).addEventListener('change', () => {
  if (k === 'preset') { $('from').value = ''; $('to').value = ''; }
  if (k === 'from' || k === 'to') $('preset').value = '';
  syncRule(); load();
});
$('more').addEventListener('click', () => load({ more: true }));

const [session, { accounts, categories }] = await Promise.all([getSession(), api('/api/facets')]);
let anchor = null, rangeCheck = false;
function checkRow(id, on, shift = false) {
  id = Number(id);
  const ids = items.map((t) => t.id), start = ids.indexOf(anchor), end = ids.indexOf(id);
  const range = shift && start >= 0 && end >= 0 ? ids.slice(Math.min(start, end), Math.max(start, end) + 1) : [id];
  for (const key of range) { if (on) picked.add(key); else picked.delete(key); }
  anchor = id;
  draw(); bar.refresh();
}
function syncSelection() {
  const visible = items.filter((t) => picked.has(t.id)).length;
  $('select-visible').checked = items.length > 0 && visible === items.length;
  $('select-visible').indeterminate = visible > 0 && visible < items.length;
  $('select-visible').disabled = !items.length;
  $('selection-count').textContent = `${picked.size} selected · ${visible} visible`;
  $('selection-count').hidden = picked.size === 0;
  $('clear-selection').hidden = picked.size === 0;
  if (picked.size) $('bulk-actions').open = true;
}
const sortColumns = { date: ['newest', 'oldest'], amount: ['amount_desc', 'amount_asc'],
  merchant: ['merchant_asc', 'merchant_desc'], category: ['category_asc', 'category_desc'] };
function syncSort() {
  for (const [column, orders] of Object.entries(sortColumns)) {
    const index = orders.indexOf($('sort').value);
    const button = $(`sort-${column}`);
    button.textContent = `${column[0].toUpperCase() + column.slice(1)}${index < 0 ? '' : ['newest', 'amount_desc', 'merchant_desc', 'category_desc'].includes(orders[index]) ? ' ↓' : ' ↑'}`;
    button.setAttribute('aria-pressed', String(index >= 0));
  }
}
for (const [column, orders] of Object.entries(sortColumns)) $(`sort-${column}`).addEventListener('click', () => {
  $('sort').value = $('sort').value === orders[0] ? orders[1] : orders[0];
  syncRule(); load();
});
if (session.owner) {
  $('selection').hidden = false;
  // Capture the click modifier because Deck's onCheck callback carries only id and state.
  $('rows').addEventListener('click', (ev) => { if (ev.target.matches('input[type="checkbox"]')) rangeCheck = ev.shiftKey; }, true);
  list.update({ checkable: true, onCheck: (id, on) => { checkRow(id, on, rangeCheck); rangeCheck = false; } });
  $('select-visible').addEventListener('change', (ev) => {
    for (const t of items) { if (ev.target.checked) picked.add(t.id); else picked.delete(t.id); }
    draw(); bar.refresh();
  });
  $('clear-selection').addEventListener('click', () => { picked.clear(); anchor = null; draw(); bar.refresh(); });
}
bar = fixBar($('fix'), { session, categories, target, onDone: () => load() });
const opt = (value, text) => Object.assign(document.createElement('option'), { value, textContent: text });
$('account').append(...accounts.map((a) => opt(a.id, `${a.name} (${a.n.toLocaleString()})`)));
const categoryPath = (c) => {
  const parent = categories.find((p) => p.id === c.parent_id);
  return parent ? `${categoryPath(parent)} › ${c.name}` : c.name;
};
const categoryChecks = [{ id: 'none', name: 'Uncategorized' }, ...categories].map((c) => {
  const input = el('input', { type: 'checkbox', value: String(c.id) });
  const label = el('label');
  label.append(input, document.createTextNode(c.id === 'none' ? c.name : categoryPath(c)));
  $('category-options').append(label, el('br'));
  input.addEventListener('input', () => {
    $('category').value = categoryChecks.filter((input) => input.checked).map((input) => input.value).join(',');
    syncRule(); load();
  });
  return input;
});
function syncCategories() {
  const selected = $('category').value.split(',');
  for (const input of categoryChecks) input.checked = selected.includes(input.value);
  const count = categoryChecks.filter((input) => input.checked).length;
  $('category-summary').textContent = count ? `Categories (${count})` : 'All categories';
}
for (const k of ['account', 'category']) $(k).value = params.get(k) ?? '';
syncCategories();
await load();
detailURL.sync();

const makeRule = el('a', { className: 'btn', textContent: 'Make a rule from this search', href: '/rules' });
$('fix').after(makeRule);
const syncRule = () => { syncFilterCount(); syncCategories(); const p = filters(); p.delete('sort'); const f = Object.fromEntries(p); makeRule.hidden = !ctx.owner || !Object.keys(f).length; makeRule.href = `/rules?filter=${encodeURIComponent(JSON.stringify(f))}`; };
document.querySelector('.filters').addEventListener('input', syncRule);
syncRule();

// Saved views store the complete query, without pagination or selected rows.
let views = [];
async function refreshViews(selected = '') {
  ({ views } = await api('/api/views'));
  $('view').replaceChildren(opt('', 'Current filters'), ...views.map((v) => opt(v.id, v.name)));
  $('view').value = selected;
  const view = views.find((v) => String(v.id) === $('view').value);
  $('view-name').value = view?.name ?? '';
  $('view-rename').disabled = $('view-delete').disabled = !view;
}
$('view-actions').hidden = !session.owner;
$('view').addEventListener('change', () => {
  clearTimeout(timer);
  const view = views.find((v) => String(v.id) === $('view').value);
  $('view-name').value = view?.name ?? '';
  $('view-rename').disabled = $('view-delete').disabled = !view;
  if (!view) return;
  for (const k of KEYS) {
    const value = view.state[k] ?? (k === 'sort' ? 'newest' : k === 'kind' ? 'spending' : '');
    if (['account'].includes(k) && value && ![...$(k).options].some((o) => o.value === value)) {
      $(k).append(opt(value, 'Saved selection (unavailable)'));
    }
    $(k).value = value;
  }
  syncRule();
  load();
});
document.querySelector('.filters').addEventListener('input', () => {
  $('view').value = '';
  $('view-rename').disabled = $('view-delete').disabled = true;
});
for (const [button, action] of [['view-save', 'create'], ['view-rename', 'rename'], ['view-delete', 'delete']]) {
  $(button).addEventListener('click', async () => {
    $(button).disabled = true;
    try {
      const result = await post('/api/views', { action, id: Number($('view').value),
        name: $('view-name').value, state: Object.fromEntries(filters()) });
      await refreshViews(action === 'delete' ? '' : String(result.id));
      $('view-status').textContent = action === 'delete' ? 'View deleted.' : 'View saved.';
    } catch (e) { $('view-status').textContent = e.message; }
    finally {
      $('view-save').disabled = false;
      $('view-rename').disabled = $('view-delete').disabled = !$('view').value;
    }
  });
}
try { await refreshViews(); } catch (e) { $('view-status').textContent = e.message; }

}
