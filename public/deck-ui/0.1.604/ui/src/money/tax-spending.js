import {describeFailure} from '../failure.js';

// Faithful port of Purser tax-spending.js at f334243; backend reads and browser services come from the mount context.
export async function mount(ctx) {
  const { mountMoneyPage, $, api, el, signIn, document, location, history, window, localStorage, sessionStorage, confirm, prompt, alert, setTimeout, clearTimeout } = ctx;
await mountMoneyPage();
$('year').value = new URLSearchParams(location.search).get('year') ?? '';
try {
  const session = await api('/api/session');
  if (!session.owner) {
    $('status').replaceChildren(el('span', {textContent: 'Money is owner-only. '}), el('a', {href: '/boarding/sign-in', textContent: 'Sign in'}));
    document.querySelector('form').hidden = true;
  }
  else {
    const { categories } = await api('/api/facets');
    $('categories').replaceChildren(...categories.filter(c => c.kind === 'expense').map(c => el('option', { value: c.id, textContent: c.path })));
    document.querySelector('form').onsubmit = () => { $('category').value = [...$('categories').selectedOptions].map(o => o.value).join(','); };
  }
} catch (e) {
  const failure = describeFailure('purser', e, {device: ctx.host.kind === 'shell'});
  $('status').replaceChildren(el('span', {textContent: failure.message}), ...(e.status === 401 ? [el('a', {href: '/boarding/sign-in', textContent: 'Sign in'})] : []));
  document.querySelector('form').hidden = true;
}

}
