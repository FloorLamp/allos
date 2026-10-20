import {h, render} from '../../vendor/preact.mjs';
import {ShellBar} from '../view/shell-bar.js';
import {needsFor} from '../needs.js';
import {drawing} from '../mount-runtime.js';
import {todoPath} from '../flightplan-paths.js';
import {siteNeeds, siteSession, siteSignOut, signInHref} from '../host/site.js';

/** The site's member slot: the name and Sign out, Sign in when boarding says signed out, nothing while unknown. */
function member(session, win) {
  if (!session) return null;
  if (!session.member) return h('a', {class: 'ds-sign-in', href: signInHref(win)}, 'Sign in');
  return h('span', {class: 'ds-member'}, h('span', {class: 'ds-member-name'}, session.member.name),
    h('button', {type: 'button', class: 'ds-sign-out', onClick: () => siteSignOut(win)}, 'Sign out'));
}

/** The site's shell bar (contract/shell-bar.md *Shell bar*). With host/needsSource it shares the Needs snapshot; other slots are text or Preact nodes.
 *  `site: true` (every page on deck.wang.team, whichever host serves it): the site's Needs and member (*The site*), the same everywhere. */
export function mountShellBar(el, opts = {}) {
  const doc = el.ownerDocument, win = doc.defaultView;
  if (doc?.location?.protocol === 'https:' && doc.location.hostname.endsWith('.wang.team') && !doc.querySelector('script[src="/boarding/client.js"]')) {
    const script = doc.createElement('script');
    script.src = '/boarding/client.js';
    doc.head.append(script);
  }
  const site = !!opts.site;
  const source = site ? siteNeeds(win) : opts.needsSource ?? (opts.host ? needsFor(opts.host) : null);
  // the Needs badge opens Todo, where Needs you leads
  const entry = () => o.nav?.find(p => p.id === 'todo');
  const snapshot = () => source ? {count: source.count, loading: source.loading, unavailable: source.failures.length > 0,
    label: 'Needs', href: entry()?.href ?? todoPath()} : o.needs;
  const search = opts.nav?.find(p => p.id === 'search');
  let o = {...(site && search ? {brand: {label: 'Deck', href: search.href}} : {}), ...opts,
    onSheetChange: opts.onSheetChange ?? (opts.host?.kind === 'shell' ? open => opts.host.note('android.menu', {open}) : undefined)};
  if (site) o.signIn = null;
  o.needs = snapshot();
  const d = drawing(el, 'ShellBar', () => render(h(ShellBar, o), el));
  const off = source?.subscribe(() => { o = {...o, needs: snapshot()}; d.draw(); });
  source?.ensure();
  let gone = false;
  const offSite = [];
  if (site) {
    const who = page => siteSession(win, {page}).then(session => { if (!gone) { o = {...o, signIn: member(session, win)}; d.draw(); } });
    const refresh = () => { source.refresh({force: true}); who(); };
    const changed = () => source.refresh({force: true});
    win.addEventListener('focus', refresh);
    win.addEventListener('deck-attention-changed', changed);
    offSite.push(() => win.removeEventListener('focus', refresh), () => win.removeEventListener('deck-attention-changed', changed));
    who(true);
  }
  return {update(next) {
    // the site's slots are its own: a host's signIn or needs never replaces them
    const {signIn, needs, site: _, ...rest} = next;
    o = {...o, ...(site ? rest : next)};
    o.needs = snapshot();
    d.draw();
  }, unmount() { gone = true; off?.(); for (const f of offSite) f(); d.unmount(); }};
}
