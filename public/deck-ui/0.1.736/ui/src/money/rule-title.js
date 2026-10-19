// Display labels only; matching and edits retain Purser's original conditions.
export function ruleTitle(conditions, category, { merchants = [], accounts = [], categories = [] } = {}) {
  if (typeof conditions === 'string') {
    try { conditions = JSON.parse(conditions); }
    catch { return `${conditions} → ${category ?? 'Uncategorized'}`; }
  }
  const name = (rows, id, fallback) => rows.find((r) => String(r.id) === String(id))?.name ?? fallback;
  const amount = (cents) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(cents / 100);
  const parts = [];
  const describe = (c = {}) => {
    for (const [key, value] of Object.entries(c)) {
      if (value === '' || value === null || value === undefined || key === 'seed') continue;
      switch (key) {
        case 'filter': describe(value); break;
        case 'merchant': case 'merchant_id': parts.push(`Merchant ${name(merchants, value, 'unavailable')}`); break;
        case 'account': case 'account_id': parts.push(`Account ${name(accounts, value, 'unavailable')}`); break;
        case 'description': case 'q': parts.push(`Description contains “${value}”`); break;
        case 'sign': parts.push(value === 'in' ? 'Money in' : 'Money out'); break;
        case 'amount_cents': parts.push(`Amount ${amount(value)}`); break;
        case 'min_cents': parts.push(`At least ${amount(value)}`); break;
        case 'max_cents': parts.push(`At most ${amount(value)}`); break;
        case 'min': parts.push(`At least ${amount(Number(value) * 100)}`); break;
        case 'max': parts.push(`At most ${amount(Number(value) * 100)}`); break;
        case 'from': parts.push(`On or after ${value}`); break;
        case 'to': parts.push(`On or before ${value}`); break;
        case 'category': parts.push(`Category ${String(value).split(',').map((id) => name(categories, id, id === 'none' ? 'Uncategorized' : 'unavailable')).join(' or ')}`); break;
        case 'kind': parts.push({ spending: 'Spending', income: 'Income', transfer: 'Transfers', all: 'All transactions' }[value] ?? 'Transaction type'); break;
        case 'sort': break; // Ordering does not affect which transactions match.
        default: parts.push('Additional condition');
      }
    }
  };
  describe(conditions);
  return `${parts.join(' and ') || 'All transactions'} → ${category ?? 'Uncategorized'}`;
}
