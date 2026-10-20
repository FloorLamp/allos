import {categoryText, ownerNotice} from './labels.js';

// Tax spending (`/spending/tax`): the owner picks a year and spending categories (each with its subcategories) and downloads their rows
// as CSV (`/api/tax-spending.csv`). Owner-only: signed out, the page says so once.
export async function mount(ctx) {
  const { mountMoneyPage, $, api, el, location, document } = ctx;
await mountMoneyPage();
const form = document.querySelector('form');
// a tax review is of a finished year: last year unless the address names one
$('year').value = new URLSearchParams(location.search).get('year') ?? String(new Date().getFullYear() - 1);
let session;
try { session = await api('/api/session'); } catch (e) { return ctx.fail(e); }
if (!session.owner) {
  form.hidden = true;
  $('status').replaceChildren(ownerNotice(ctx, session, 'Sign in as the owner to download tax spending.'));
  return;
}
let categories;
try { ({ categories } = await api('/api/facets')); } catch (e) { return ctx.fail(e); }
const spending = categories.filter((c) => c.kind === 'expense').sort((a, b) => a.path.localeCompare(b.path));
if (!spending.length) {
  form.hidden = true;
  return ctx.empty({ title: 'No spending categories yet', line: 'Import a Simplifi export, and its spending categories show here to pick from.', glyph: 'receipt' });
}
const checks = spending.map((c) => {
  const input = el('input', { type: 'checkbox', value: String(c.id) });
  $('categories').append(el('label', { className: `dm-check${c.parent_id ? ' child' : ''}` }, input, categoryText(c.path)));
  return input;
});
const sync = () => {
  const picked = checks.filter((c) => c.checked).map((c) => c.value);
  $('category').value = picked.join(',');
  $('download').disabled = !picked.length || !/^\d{4}$/.test($('year').value);
  $('status').textContent = picked.length ? '' : 'Pick at least one category.';
};
form.addEventListener('input', sync);
sync();

}
