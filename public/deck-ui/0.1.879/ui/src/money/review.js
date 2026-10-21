import {h, render} from '../../vendor/preact.mjs';
import {countText, plural} from '../format.js';
import {PageState} from '../view/page-state.js';
import {ChipGroup} from '../view/chip-group.js';
import {moneyFailure, MoneyValidationError} from './failure.js';
import {categoryText, ownerNotice} from './labels.js';
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
let loadedOnce = false;
const SHOWN = 3;

function picker(selected) {
  const s = el('select', { className: 'pick', ariaLabel: 'Category' }, el('option', { value: '', textContent: 'Pick a category' }));
  for (const c of categories) s.append(el('option', { value: c.id, textContent: categoryText(c.path), selected: c.id === selected }));
  return s;
}

function card(r, reason = false) {
  const p = r.proposal;
  const members = r.members ?? [r], many = members.length > 1;
  const ids = r.ids ?? [r.id];
  const error = el('div', { className: 'bad', role: 'status' });
  const detail = el('div');
  let what, acts = [];
  const answer = (body) => async (ev) => {
    if (busy) return;
    const index = Math.max(0, items.findIndex(item => item.id === activeId));
    busy = true;
    ev.target.disabled = true;
    try {
      if (ids.length > 1) {
        const result = await post('/api/reviews/answer', { ids, ...body(), queue_kind: kind, queue_limit: Math.max(PAGE, queue.items.length) });
        selected.clear(); showQueue(result.queue);
      } else { await post(`/api/review/${r.id}`, body()); await load(); }
      $('items').querySelectorAll('.item')[Math.min(index, items.length - 1)]?.focus();
    } catch (e) { error.textContent = moneyFailure(e, 'update the review queue'); ev.target.disabled = false; }
    finally { busy = false; renderBatch(); }
  };
  const btn = (text, body) => el('button', { className: 'btn', type: 'button', textContent: text, onclick: answer(body) });
  if (p.batch) {
    what = p.title;
    acts = [el('button', { className: 'btn', type: 'button', textContent: 'Preview batch', onclick: async () => {
      try {
        const preview = await api(`/api/review/${r.id}/preview`);
        detail.replaceChildren(el('div', { className: 'rows' }, ...preview.changes.map((c) => el('div', {
          textContent: `${categoryText(c.from)} → ${categoryText(c.to)}${c.pair ? ' · paired as a transfer' : ''}`
        }))), btn(`Confirm ${preview.rows} rows`, () => ({ accept: true, token: preview.token })));
      } catch (e) { error.textContent = moneyFailure(e, 'update the review queue'); }
    } }), btn('Leave it', () => ({ accept: false }))];
  } else if (r.kind === 'category' && r.merchant) {
    what = `Rule: ${r.merchant.name} → ${categoryText(p.category?.name)} (from ${plural(r.edits, 'correction')})`;
    acts = [btn('Make the rule', () => ({ accept: true })), btn('Not a rule', () => ({ accept: false }))];
  } else if (r.kind === 'category') {
    what = p.category ? `${categoryText(p.category.name)}?${r.confidence != null ? ` ${Math.round(r.confidence * 100)}% sure` : ''}` : many ? 'No rule covers these' : 'No rule covers this';
    const s = picker(p.category?.id);
    const cat = () => { if (!s.value) throw new MoneyValidationError('pick a category'); return Number(s.value); };
    acts = [s, btn(many ? `These ${members.length}` : 'This one', () => ({ accept: true, category_id: cat(), scope: 'this' })), btn('This and future', () => ({ accept: true, category_id: cat(), scope: 'future' })),
      btn(many ? 'Skip these' : 'Skip', () => ({ accept: false }))];
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
  if (reason) return el('div', { className: 'reason' }, el('div', { className: 'what', textContent: what }),
    el('div', { className: 'rows' }, ...r.txns.slice(1).map((t) => el('div', { textContent: line(t) }))),
    owner ? el('div', { className: 'acts' }, ...acts) : null, detail, error);
  // the card's head: what it is about (the merchant, else the payee), when and where, the money trailing; the question under it
  const txns = members.flatMap((m) => m.txns), first = txns[0];
  const name = r.group?.name ?? r.merchant?.name ?? first?.description ?? null;
  const cents = (many ? txns : txns.slice(0, 1)).reduce((n, t) => n + t.amount_cents, 0);
  const where = many ? plural(members.length, 'transaction') : first ? `${day(first.date)} · ${first.account}` : '';
  const listed = many || txns.length > 1 ? txns : [];
  return el('div', { className: 'item', tabIndex: 0, onfocusin: () => { activeId = r.id; } },
    el('div', { className: 'dm-review-head' }, owner ? el('input', { type: 'checkbox', ariaLabel: `Select ${name ?? what}`, checked: selected.has(r.id), onchange: (ev) => {
      if (busy) { ev.target.checked = selected.has(r.id); return; }
      ev.target.checked ? selected.add(r.id) : selected.delete(r.id); renderBatch();
    } }) : null,
      // a review of no one transaction (a batch) is titled by its question
      el('div', { className: 'dm-review-title' }, el('b', { textContent: name ?? what }), el('span', { className: 'meta', textContent: [where, name ? what : null].filter(Boolean).join(' · ') })),
      first ? el('span', { className: 'dm-review-amount', textContent: money(cents) }) : null),
    listed.length ? el('div', { className: 'rows' }, ...listed.slice(0, SHOWN).map((t) => el('div', { textContent: line(t) })),
      listed.length > SHOWN ? el('div', { textContent: `and ${countText(listed.length - SHOWN)} more` }) : null) : null,
    owner ? el('div', { className: 'acts' }, ...acts) : null, detail, error, ...members.flatMap((m) => m.reasons ?? []).map(other => card(other, true)));
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
    loadedOnce = true;
  } catch (e) {
    if (!loadedOnce) return ctx.fail(e);
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
  // a merchant's open category questions are one card: one answer for all of them (Purser's group)
  const cards = new Map();
  for (const review of grouped.values()) {
    const key = review.kind === 'category' && !review.proposal?.batch && !review.merchant && review.group?.count > 1 ? `group:${review.group.key}` : `review:${review.id}`;
    const have = cards.get(key);
    if (have) { have.members.push(review); have.ids.push(review.id, ...review.reasons.map((x) => x.id)); }
    else cards.set(key, {...review, members: [review], ids: [review.id, ...review.reasons.map((x) => x.id)]});
  }
  const size = (c) => Math.abs(c.members.flatMap((m) => m.txns).reduce((n, t) => n + t.amount_cents, 0));
  const sorted = [...cards.values()].map((c) => c.members.length > 1 ? c : {...c, members: undefined}).sort((a, b) =>
    (b.members ? size(b) : Math.max(0, ...b.txns.map(t => Math.abs(t.amount_cents)))) - (a.members ? size(a) : Math.max(0, ...a.txns.map(t => Math.abs(t.amount_cents)))) || a.id - b.id);
  total = sorted.length;
  page = Math.min(page, Math.max(0, Math.ceil(total / PAGE) - 1));
  items = sorted.slice(page * PAGE, (page + 1) * PAGE);
  // the count the Review tab shows (each question), the range only when the cards page
  const open = kind ? r.byKind?.[kind] ?? 0 : r.total ?? total;
  $('summary').textContent = [`${countText(open)} open`, total > PAGE ? `${page * PAGE + 1}–${Math.min((page + 1) * PAGE, total)} of ${countText(total)}` : null, total ? 'Largest amounts first' : null].filter(Boolean).join(' · ');
  if (!items.some((r) => r.id === activeId)) activeId = items[0]?.id ?? null;
  if (items.length) $('items').replaceChildren(...groupedCards());
  else {
    $('items').replaceChildren();
    render(h(PageState, { state: 'empty', glyph: 'check', title: 'Nothing to review', hint: kind ? 'Nothing of this kind is waiting.' : 'Every transaction has what it needs.' }), $('items'));
  }
  $('items').className = `panel queue${items.length ? '' : ' dm-empty-queue'}`;
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
    const r = await post('/api/reviews/answer', { ids: items.filter(r => selected.has(r.id)).flatMap(r => r.ids), ...body, queue_kind: kind, queue_limit: Math.max(PAGE, queue.items.length) });
    selected.clear();
    showQueue(r.queue);
  } catch (e) { $('batch-error').textContent = moneyFailure(e, 'update the review queue'); }
  finally { busy = false; renderBatch(); }
}

function renderBatch() {
  $('batch').hidden = !owner || !items.length;
  if (!owner || !items.length) return;
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
  render(h(ChipGroup, { label: 'Kinds', value: kind, options: KINDS.map(([value, label]) => ({ value, label })), onChange: (k) => {
    if (busy) return;
    kind = k; page = 0;
    renderKinds();
    history.replaceState(null, '', k ? `/review?kind=${k}` : '/review');
    load();
  } }), $('kinds'));
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
let session, facets;
try { [session, facets] = await Promise.all([getSession(), api('/api/facets')]); } catch (e) { return ctx.fail(e); }
owner = session.owner;
categories = facets.categories;
if (!owner) { $('signin').hidden = false; $('signin').replaceChildren(ownerNotice(ctx, session, 'Sign in as the owner to answer.')); }
await load();

}
