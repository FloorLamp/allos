import {moneyFailure, MoneyValidationError} from './failure.js';
// Faithful port of Purser review.js at f334243; backend reads and browser services come from the mount context.
export async function mount(ctx) {
  const { mountMoneyPage, $, api, post, el, session: getSession, money, day, document, location, history, window, localStorage, sessionStorage, confirm, prompt, alert, setTimeout, clearTimeout } = ctx;
// The review queue (`/review`): proposed rules, rows the rules leave uncategorised or unsure, unmatched transfers, look-alike split
// lines. Everyone on the family network reads it; answering needs the owner's session (the server checks; this page only hides the
// buttons). Answers run the rule pipeline; batch answers return the updated queue.
await mountMoneyPage();

let KINDS = [['', 'All']];
const PAGE = 50;
let kind = new URLSearchParams(location.search).get('kind') ?? '', items = [], total = 0, owner = false, categories = [];

const selected = new Set();
let busy = false, activeId = null, page = 0, queue = null;

const line = (t) => `${day(t.date)} · ${t.account} · ${t.description || '(no payee)'} · ${money(t.amount_cents)}`;

function picker(selected) {
  const s = el('select', { className: 'pick', ariaLabel: 'Category' }, el('option', { value: '', textContent: 'Pick a category' }));
  for (const c of categories) s.append(el('option', { value: c.id, textContent: c.path.replaceAll(':', ' › '), selected: c.id === selected }));
  return s;
}

function card(r, reason = false) {
  const p = r.proposal;
  const error = el('div', { className: 'bad', role: 'status' });
  const detail = el('div');
  let what, acts = [];
  const answer = (body) => async (ev) => {
    if (busy) return;
    const index = Math.max(0, items.findIndex(item => item.id === activeId));
    busy = true;
    ev.target.disabled = true;
    try { await post(`/api/review/${r.id}`, body()); await load(); $('items').querySelectorAll('.item')[Math.min(index, items.length - 1)]?.focus(); } catch (e) { error.textContent = moneyFailure(e, 'update the review queue'); ev.target.disabled = false; }
    finally { busy = false; renderBatch(); }
  };
  const btn = (text, body) => el('button', { className: 'btn', type: 'button', textContent: text, onclick: answer(body) });
  if (p.batch) {
    what = p.title;
    acts = [el('button', { className: 'btn', type: 'button', textContent: 'Preview batch', onclick: async () => {
      try {
        const preview = await api(`/api/review/${r.id}/preview`);
        detail.replaceChildren(el('div', { className: 'rows' }, ...preview.changes.map((c) => el('div', {
          textContent: `#${c.id}: ${(c.from ?? 'Uncategorized').replaceAll(':', ' › ')} → ${c.to.replaceAll(':', ' › ')}${c.pair ? ` · paired with #${c.pair}` : ''}`
        }))), btn(`Confirm ${preview.rows} rows`, () => ({ accept: true, token: preview.token })));
      } catch (e) { error.textContent = moneyFailure(e, 'update the review queue'); }
    } }), btn('Leave it', () => ({ accept: false }))];
  } else if (r.kind === 'category' && r.merchant) {
    what = `Rule: ${r.merchant.name} → ${p.category?.name.replaceAll(':', ' › ') ?? '?'} (from ${r.edits} corrections)`;
    acts = [btn('Make the rule', () => ({ accept: true })), btn('Not a rule', () => ({ accept: false }))];
  } else if (r.kind === 'category') {
    what = p.category ? `${p.category.name.replaceAll(':', ' › ')}?${r.confidence != null ? ` ${Math.round(r.confidence * 100)}% sure` : ''}` : 'No rule covers this';
    const s = picker(p.category?.id);
    const cat = () => { if (!s.value) throw new MoneyValidationError('pick a category'); return Number(s.value); };
    acts = [s, btn('This one', () => ({ accept: true, category_id: cat(), scope: 'this' })), btn('This and future', () => ({ accept: true, category_id: cat(), scope: 'future' })),
      btn('Skip', () => ({ accept: false }))];
  } else if (r.kind === 'transfer') {
    what = 'A transfer with no other side found';
    acts = [btn('To an outside account', () => ({ accept: true })), btn('Leave it', () => ({ accept: false }))];
  } else if (r.kind === 'merge') {
    what = 'A live row that looks like earlier ones: which is it?';
    acts = [...r.txns.slice(1).map((t) => btn(`It is ${day(t.date)}`, () => ({ accept: true, into: t.id }))), btn('Keep it separate', () => ({ accept: false }))];
  } else if (r.kind === 'removed') {
    what = 'The bank dropped a row you edited';
    acts = [btn('Let it go', () => ({ accept: true })), btn('Keep it', () => ({ accept: false }))];
  } else if (r.kind === 'split') {
    what = 'Look-alike lines: one split transaction?';
    acts = [btn('Make one split', () => ({ accept: true })), btn('Separate', () => ({ accept: false }))];
  }
  return el('div', { className: reason ? 'reason' : 'item', tabIndex: reason ? -1 : 0, onfocusin: () => { activeId = r.id; } }, owner && !reason ? el('input', { type: 'checkbox', ariaLabel: `Select review ${r.id}`, checked: selected.has(r.id), onchange: (ev) => {
    if (busy) { ev.target.checked = selected.has(r.id); return; }
    ev.target.checked ? selected.add(r.id) : selected.delete(r.id); renderBatch();
  } }) : null, el('div', { className: 'what', textContent: what }),
    el('div', { className: 'rows' }, ...(reason ? r.txns.slice(1) : r.txns).map((t) => el('div', { textContent: line(t) }))),
    owner ? el('div', { className: 'acts' }, ...acts) : null, detail, error, ...(r.reasons ?? []).map(other => card(other, true)));
}

function groupedCards() {
  return items.map(r => card(r));
}

async function load() {
  try {
    // Purser pages by merchant. Read its pages before sorting and combining reasons locally.
    let offset = 0, rows = [], r;
    do {
      const p = new URLSearchParams({ limit: PAGE, offset });
      if (kind) p.set('kind', kind);
      r = await api(`/api/reviews?${p}`);
      rows.push(...r.items);
      offset += r.items.length;
    } while (r.items.length && offset < (kind ? r.byKind[kind] ?? 0 : r.total));
    selected.clear();
    showQueue({...r, items: rows});
  } catch (e) {
    $('items').replaceChildren(el('div', { className: 'empty', textContent: moneyFailure(e, 'update the review queue') }));
  }
}

function showQueue(r) {
  queue = r;
  KINDS = [['', 'All'], ...r.kinds.filter(({kind: k}) => (r.byKind[k] ?? 0) > 0).map(({ kind, label }) => [kind, label])];
  renderKinds();
  const grouped = new Map();
  for (const review of r.items) {
    const key = review.txns[0]?.id == null ? `review:${review.id}` : `txn:${review.txns[0].id}`;
    if (grouped.has(key)) grouped.get(key).reasons.push(review);
    else grouped.set(key, {...review, reasons: []});
  }
  const sorted = [...grouped.values()].sort((a, b) =>
    Math.max(0, ...b.txns.map(t => Math.abs(t.amount_cents))) - Math.max(0, ...a.txns.map(t => Math.abs(t.amount_cents))) || a.id - b.id);
  total = sorted.length;
  page = Math.min(page, Math.max(0, Math.ceil(total / PAGE) - 1));
  items = sorted.slice(page * PAGE, (page + 1) * PAGE);
  $('summary').textContent = `${total.toLocaleString()} open · ${total ? page * PAGE + 1 : 0}–${Math.min((page + 1) * PAGE, total)} · Largest amounts first`;
  if (!items.some((r) => r.id === activeId)) activeId = items[0]?.id ?? null;
  $('items').replaceChildren(...(items.length ? groupedCards() : [el('div', { className: 'empty', textContent: 'Nothing to review.' })]));
  $('more').hidden = (page + 1) * PAGE >= total;
  $('more').textContent = 'Next 50';
  $('previous').hidden = page === 0;
  renderBatch();
}

async function answerSelected(body) {
  if (busy || !selected.size) return;
  busy = true;
  $('batch-error').textContent = '';
  renderBatch();
  try {
    const r = await post('/api/reviews/answer', { ids: items.filter(r => selected.has(r.id)).flatMap(r => [r.id, ...r.reasons.map(reason => reason.id)]), ...body, queue_kind: kind, queue_limit: Math.max(PAGE, queue.items.length) });
    selected.clear();
    showQueue(r.queue);
  } catch (e) { $('batch-error').textContent = moneyFailure(e, 'update the review queue'); }
  finally { busy = false; renderBatch(); }
}

function renderBatch() {
  $('batch').hidden = !owner;
  if (!owner) return;
  const category = picker();
  const button = (text, onclick) => el('button', { type: 'button', className: 'btn', textContent: text, disabled: busy || !selected.size, onclick });
  $('batch').replaceChildren(el('span', { textContent: `${selected.size} selected` }),
    el('button', { type: 'button', className: 'btn', textContent: 'Select loaded', disabled: busy, onclick: () => {
      for (const r of items) selected.add(r.id);
      $('items').replaceChildren(...groupedCards()); renderBatch();
    } }), category,
    button('Accept selected', () => answerSelected({ accept: true, ...(category.value ? { category_id: Number(category.value), scope: 'this' } : {}) })),
    button('Skip selected', () => answerSelected({ accept: false })));
}

function renderKinds() {
  $('kinds').replaceChildren(...KINDS.map(([k, name]) => el('button', { type: 'button', role: 'tab', textContent: name, ariaSelected: String(k === kind), onclick: () => {
    if (busy) return;
    kind = k; page = 0;
    for (const b of $('kinds').children) b.ariaSelected = String(b.textContent === name);
    history.replaceState(null, '', k ? `/review?kind=${k}` : '/review');
    load();
} })));
}
// Shortcuts invoke the same controls as pointer actions, including proposal previews.
function reviewKey(event) {
  if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || busy ||
      event.target.closest('input, textarea, select') || event.target.isContentEditable ||
      event.target.closest('[contenteditable]:not([contenteditable="false"])')) return;
  if (!['j', 'k', 'a', 'c', 'f', 's', 'u', 'x', 'A'].includes(event.key)) return;
  if (!items.length || (!owner && !['j', 'k'].includes(event.key))) return;
  const cards = [...$('items').querySelectorAll('.item')];
  let index = Math.max(0, items.findIndex((r) => r.id === activeId));
  event.preventDefault();
  if (event.key === 'j' || event.key === 'k') {
    index = Math.max(0, Math.min(items.length - 1, index + (event.key === 'j' ? 1 : -1)));
    activeId = items[index].id;
    cards[index]?.focus();
    return;
  }
  const current = cards[index];
  const buttons = [...current.querySelectorAll('.acts button')];
  switch (event.key) {
    case 'a': buttons[0]?.click(); break;
    case 'c': current.querySelector('select')?.focus(); break;
    case 'f': buttons.find((b) => b.textContent === 'This and future')?.click(); break;
    case 's':
      if (selected.size) $('batch').querySelectorAll('button')[2]?.click();
      else buttons.at(-1)?.click();
      break;
    case 'u':
      selected.clear();
      for (const checkbox of $('items').querySelectorAll('input[type="checkbox"]')) checkbox.checked = false;
      renderBatch();
      break;
    case 'x': current.querySelector('input[type="checkbox"]')?.click(); break;
    case 'A': $('batch').querySelectorAll('button')[1]?.click(); break;
  }
}
document.addEventListener('keydown', reviewKey);
$('more').addEventListener('click', () => { if (!busy) { page++; selected.clear(); showQueue(queue); $('items').querySelectorAll('.item')[0]?.focus(); } });
$('previous').addEventListener('click', () => { if (!busy) { page--; selected.clear(); showQueue(queue); $('items').querySelectorAll('.item')[0]?.focus(); } });
const [session, facets] = await Promise.all([getSession(), api('/api/facets')]);
owner = session.owner;
categories = facets.categories;
if (!owner) {
  $('signin').hidden = false;
  if (!session.configured) $('signin').textContent = 'Answering needs the owner’s sign-in, not set up here yet.';
}
await load();

}
