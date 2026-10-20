// Money's one route table: each address under Deck's /money and the page it renders. Purser imports this file from its vendored
// bundle and serves the Money shell at exactly these paths; any other path is not found (the mount's not-found state, HTTP 404).
// `/link/oauth` is the OAuth redirect registered in the owner's Plaid dashboard (purser docs/prod.md); it moves only with it.
export const MONEY_ROUTES = Object.freeze({
  '/': 'overview', '/transactions': 'page', '/review': 'review',
  '/spending': 'reports', '/spending/merchants': 'merchants', '/spending/merchant': 'merchant', '/spending/recurring': 'subscriptions',
  '/spending/tax': 'tax-spending',
  '/accounts': 'accounts', '/accounts/connections': 'link', '/accounts/imports': 'imports', '/accounts/investments': 'investments',
  '/link/oauth': 'link',
  '/rules': 'classification', '/rules/categories': 'classification',
});

/** The page a Money path (without the base) renders, or undefined: no such page. */
export const moneyPage = path => Object.hasOwn(MONEY_ROUTES, path) ? MONEY_ROUTES[path] : undefined;

/** Connections runs Plaid Link, which only its own document's content security policy allows (Purser's server): reached by a
 *  page load, never in place. */
export const PLAID_PAGE = 'link';
