const REDIRECTS = {'/overview': '/', '/reports': '/spending', '/merchants': '/spending/merchants', '/merchant': '/spending/merchant',
  '/subscriptions': '/spending/recurring', '/tax-spending': '/spending/tax', '/link': '/accounts/connections',
  '/link/oauth': '/accounts/connections/oauth', '/imports': '/accounts/imports', '/investments': '/accounts/investments', '/categories': '/rules/categories'};
export function moneyRoute(path, search = '') {
  return (path === '/' && search ? '/transactions' : REDIRECTS[path]) ?? path;
}
