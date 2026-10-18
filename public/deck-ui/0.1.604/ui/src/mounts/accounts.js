import {h, render} from '../../vendor/preact.mjs';
import {createAccounts} from '../accounts.js';
import {Accounts} from '../view/accounts.js';
import {drawing} from '../mount-runtime.js';

/** The Accounts page (contract/accounts.md *Accounts*), offered where the host has registered backends (`host.backends`); else nothing is
 *  drawn. Fetched now and whenever the host emits `needs` (a needs change); no timer. opts: `brand`, `nav`, `current`, `clock`. Answers {accounts, refresh(), update(opts), unmount()}; `accounts` is
 *  null when not offered. */
export function mountAccounts(el, host, opts = {}) {
  if (!host.backends?.length) return {accounts: null, refresh() {}, update() {}, unmount() {}};
  let o = opts;
  const accounts = createAccounts(host, {clock: o.clock});
  const d = drawing(el, 'Accounts', () => render(h(Accounts, {accounts, host, opts: o}), el));
  accounts.subscribe(() => d.draw());
  const off = host.on?.('needs', () => accounts.refresh());
  accounts.start();
  return {accounts, refresh: () => accounts.refresh(), update(next) { o = {...o, ...next}; d.draw(); }, unmount() { off?.(); accounts.stop(); d.unmount(); }};
}
