// Purser f334243 correction behavior; web-only services are injected.
export function createFixBar({api, post, el, money, day, signIn}) {
// The correction bar the Transactions and merchant pages share: a category from the tree for the rows the page names (picked rows,
// the filter's rows, or a merchant's), at a scope: these rows, all from their merchants, or this and future (also a rule). A change
// beyond the picked rows is previewed first (its count, merchants and a sample), then written as previewed. The last change undoes.
// Signed out, the bar is a sign-in link. The server checks the owner; this only hides the controls.

const path = (name) => (name ?? 'Uncategorized').replaceAll(':', ' › ');

/**
 * el: the bar's element. session: {owner, configured}. categories: the tree (facets). target(): {spec, label, scopes} or null, where
 * spec is the change's rows ({txns}, {filter} or {merchant}), label says which, scopes are the buttons offered ([[scope, text]]).
 * onDone(): after a change or an undo.
 */
function fixBar(root, { session, categories, target, onDone }) {
  if (!session.owner) {
    root.replaceChildren(el('p', { className: 'meta' }, ...(session.configured
      ? ['Fixing categories needs the owner: ', el('a', { className: 'link', href: signIn(), textContent: 'sign in' }), '.']
      : ['Fixing categories needs the owner’s sign-in, not set up here yet.'])));
    return { refresh() {} };
  }
  const pick = el('select', { className: 'pick', ariaLabel: 'New category' }, el('option', { value: '', textContent: 'Set category…' }),
    ...categories.map((c) => el('option', { value: c.id, textContent: path(c.path) })));
  const what = el('span', { className: 'meta' });
  const buttons = el('span', { className: 'acts' });
  const plan = el('div', { className: 'plan', hidden: true });
  const last = el('div', { className: 'meta last' });
  root.replaceChildren(el('div', { className: 'acts' }, what, pick, buttons), plan, last);

  const fail = (e) => { plan.hidden = false; plan.replaceChildren(el('div', { className: 'bad', textContent: e.message })); };
  const category = () => { if (!pick.value) throw new Error('pick a category first'); return Number(pick.value); };

  async function apply(body) {
    const selected = body.scope === 'this' && body.txns?.length === 1 ? { ...body, scope: 'merchant' } : null;
    const r = await post('/api/recategorise', body);
    plan.hidden = true;
    await onDone();
    await showLast(r.rows ? `Changed ${r.rows.toLocaleString()} ${r.rows === 1 ? 'row' : 'rows'}${r.rules.length ? `, ${r.rules.length} ${r.rules.length === 1 ? 'rule' : 'rules'}` : ''}.` : 'Nothing to change.');
    if (selected) last.append(' ', el('button', { className: 'btn', type: 'button', textContent: 'Apply to similar…', onclick: () => start('merchant', selected) }));
  }

  async function start(scope, selected) {
    const t = selected ? { spec: { txns: selected.txns } } : target();
    if (!t) return;
    let body;
    try { body = { ...t.spec, scope, category_id: selected?.category_id ?? category() }; } catch (e) { return fail(e); }
    // the picked rows alone: written at once (undo is there)
    if (scope === 'this' && t.spec.txns) return apply(body).catch(fail);
    let p;
    try { p = await api(`/api/recategorise?change=${encodeURIComponent(JSON.stringify(body))}`); } catch (e) { return fail(e); }
    const n = (k, one, many) => (p[k] ? `${p[k].toLocaleString()} ${p[k] === 1 ? one : many}` : null);
    const facts = [n('change', 'row changes', 'rows change'), n('confirm', 'already so, now yours', 'already so, now yours'), n('same', 'yours already', 'yours already'),
      n('kept', 'you set otherwise kept', 'you set otherwise kept'), n('skipped', 'skipped (a split or removed)', 'skipped (splits or removed)')].filter(Boolean);
    const rules = p.rules.length ? ` · ${p.rules.length === 1 ? 'a rule' : `${p.rules.length} rules`} for ${p.rules.length === 1 ? 'its merchant' : 'their merchants'}, this and future` : '';
    const merchants = p.merchants ? `${p.merchants.toLocaleString()} ${p.merchants === 1 ? 'merchant' : 'merchants'}: ${p.merchantList.map((m) => `${m.name} (${m.rows})`).join(', ')}${p.merchants > p.merchantList.length ? ', …' : ''}` : null;
    const go = el('button', { className: 'btn primary', type: 'button', textContent: `Apply to ${p.rows.toLocaleString()}`, disabled: !p.rows && !p.rules.length,
      onclick: async () => { go.disabled = true; await apply({ ...body, expect: p.rows }).catch((e) => { go.disabled = false; fail(e); }); } });
    plan.hidden = false;
    plan.replaceChildren(
      el('div', { className: 'what', textContent: `→ ${path(p.category?.name)}: ${facts.join(' · ') || 'nothing to change'}${rules}` }),
      merchants ? el('div', { className: 'meta', textContent: merchants }) : null,
      el('div', { className: 'rows' }, ...p.sample.map((s) => el('div', { textContent: `${day(s.date)} · ${s.description || '(no payee)'} · ${money(s.amount_cents)} · ${path(s.from?.name)} → ${path(p.category?.name)}` })),
        p.rows > p.sample.length ? el('div', { textContent: `and ${(p.rows - p.sample.length).toLocaleString()} more` }) : null),
      el('div', { className: 'acts' }, go, el('button', { className: 'btn', type: 'button', textContent: 'Cancel', onclick: () => { plan.hidden = true; } })));
  }

  async function showLast(lead = '') {
    const { change: c } = await api('/api/last-change').catch(() => ({ change: null }));
    const undo = c && !c.undone ? el('button', { className: 'btn', type: 'button', textContent: 'Undo', onclick: async () => {
      undo.disabled = true;
      try { await post(`/api/undo/${c.id}`, {}); await onDone(); await showLast('Undone.'); } catch (e) { undo.disabled = false; fail(e); }
    } }) : null;
    const said = c && !c.undone ? `Last change: ${c.rows.toLocaleString()} ${c.rows === 1 ? 'row' : 'rows'} → ${path(c.category)}${c.rules ? ', with a rule' : ''}.` : '';
    last.replaceChildren(...[lead, said].filter(Boolean).map((t) => `${t} `), ...(undo ? [undo] : []));
  }

  function refresh() {
    const t = target();
    what.textContent = t ? t.label : 'Pick rows, or search or filter, to fix their category';
    buttons.replaceChildren(...(t ? t.scopes : []).map(([scope, text]) => el('button', { className: 'btn', type: 'button', textContent: text, onclick: () => start(scope) })));
    pick.disabled = !t;
    plan.hidden = true;
  }
  refresh();
  showLast();
  return { refresh };
}

return fixBar;
}
