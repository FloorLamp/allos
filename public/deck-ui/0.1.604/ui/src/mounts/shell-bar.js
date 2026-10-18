import {h, render} from '../../vendor/preact.mjs';
import {ShellBar} from '../view/shell-bar.js';
import {needsFor} from '../needs.js';
import {drawing} from '../mount-runtime.js';

/** The site's shell bar (contract/shell-bar.md *Shell bar*). With host/needsSource it shares the Needs snapshot; other slots are text or Preact nodes. */
export function mountShellBar(el, opts = {}) {
  const doc = el.ownerDocument;
  if (doc?.location?.protocol === 'https:' && doc.location.hostname.endsWith('.wang.team') && !doc.querySelector('script[src="/boarding/client.js"]')) {
    const script = doc.createElement('script');
    script.src = '/boarding/client.js';
    doc.head.append(script);
  }
  const source = opts.needsSource ?? (opts.host ? needsFor(opts.host) : null);
  const snapshot = () => source ? {...(opts.needs ?? {}), count: source.count, label: opts.needs?.label ?? 'All needs', href: opts.needs?.href ?? '/flightplan#needs'} : opts.needs;
  let o = {...opts, needs: snapshot()};
  const d = drawing(el, 'ShellBar', () => render(h(ShellBar, o), el));
  const off = source?.subscribe(() => { o = {...o, needs: snapshot()}; d.draw(); });
  source?.ensure();
  return {update(next) { o = {...o, ...next, ...(source ? {needs: snapshot()} : {})}; d.draw(); }, unmount() { off?.(); d.unmount(); }};
}
