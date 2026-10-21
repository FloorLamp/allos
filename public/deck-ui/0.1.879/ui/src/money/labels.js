// Money's words and figures, one rule each, for every Money page: categories as `Food › Groceries`, Purser's codes as words,
// spending as money out (never negative: more refunded than spent reads `+$12.00`), and the owner-only notice.
import {fieldLabel} from '../format.js';
import {formatQuantity} from '../quantity.js';

/** A category path as Simplifi writes it (`Food & Dining:Groceries`) as people read it: `Food & Dining › Groceries`; none: Uncategorized. */
export const categoryText = path => path ? String(path).replaceAll(':', ' › ') : 'Uncategorized';

/** A category kind: expense, income, transfer. */
export const kindText = kind => ({expense: 'Spending', income: 'Income', transfer: 'Transfer'})[kind] ?? fieldLabel(kind);

/** An account type as Purser stores it. */
export const accountTypeText = type => ({credit: 'Card', checking: 'Checking', savings: 'Savings', loan: 'Loan', investment: 'Investment'})[type] ?? fieldLabel(type ?? 'account');

/** Where a row came from. */
export const sourceText = source => ({simplifi: `Simplifi export`, plaid: 'Plaid', coinbase: 'Coinbase CSV', user: 'You', owner: 'You'})[source] ?? fieldLabel(source);

/** Spending as a quantity (Purser's spending cents: money out positive): `$42.50`, and money back, when refunds outweigh it, `+$12.00`. */
export const spentQuantity = cents => cents < 0
  ? {value: -cents / 100, format: 'currency', unit: 'USD', sign: 'always', tone: 'good'}
  : {value: (cents ?? 0) / 100, format: 'currency', unit: 'USD', tone: 'neutral'};
export const spentText = cents => formatQuantity(spentQuantity(cents));

/** Money in or out without a sign, as a figure: `$10,400.00`. */
export const amountQuantity = cents => ({value: Math.abs(cents ?? 0) / 100, format: 'currency', unit: 'USD', tone: 'neutral'});
export const amountText = cents => formatQuantity(amountQuantity(cents));

/** The one notice for a signed-out reader where the owner can change things: the shared inline state (view/page-state.js StateBlock's
 *  `dk-state inline` markup, built with the page's own elements), a quiet line and Sign in. session: {configured}. */
export function ownerNotice(ctx, session, line = 'Sign in as the owner to make changes.') {
  const native = ctx.host && ctx.host.kind !== 'web', unset = session?.configured === false;
  const text = native ? 'Owner actions are available in Deck web.' : unset ? 'Changes need the owner’s sign-in, which isn’t set up here yet.' : line;
  return ctx.el('div', {className: 'dm-owner-notice'}, ctx.el('div', {className: 'dk-state inline'}, ctx.el('p', {textContent: text}),
    native || unset ? null : ctx.el('div', {className: 'acts'}, ctx.el('a', {className: 'dk-btn main', href: ctx.signIn(), textContent: 'Sign in'}))));
}
