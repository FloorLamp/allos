# Foundation

## Foundation

Every page shares one look (`view/foundation.css`, loaded by every mount; `tokens.css` is generated, this file is not). Tokens:
`--space-section` (24: between a page's sections and blocks) and `--space-item` (8: between the parts inside one), `--font-figure`
(22/26, the number to read first), `--font-figure-lg` (28/32), `--font-section` (a date or section heading), `--drawer-width`,
`--sticky-top` (set it where the page has a fixed bar above the sticky section headings). Tones are classes, never raw colours:
`tone-good` (`--ok`), `tone-bad` (`--bad`), `tone-neutral` (`--text`); a delta also carries an arrow, so no tone is colour alone.

### Quantity

Everything that shows a number takes a quantity, whatever it measures; money is one preset. `quantity.js` (no DOM), re-exported by
`mount.js`:

```js
quantity = {value, unit?, format?: 'number' | 'currency' | 'percent' | 'duration', precision?, sign?: 'auto' | 'always', tone?: 'good' | 'bad' | 'neutral'}
formatQuantity({value: 7.4, unit: 'gal'})               // '7.4 gal'; {value: 62, format: 'percent'} → '62%'; {value: 276000, format: 'duration'} → '3d 4h' (seconds)
money(-42.5, {currency?, tone?})                        // the preset: currency, sign 'always', tone good when positive (money in), else neutral → '−$42.50', '+$1,200.00'
delta(q, from, {label?, higher, pct?})                  // → {text: '+2 gal', pct: '+17%', tone, dir, label}; `higher`: what more means ('good', 'bad', 'neutral')
toneFor(value, higher)                                  // the tone of a signed value, for a quantity's own `tone`
dateSection('2026-10-12', now)                          // → {key, label}: 'Today', 'Yesterday', 'Mon, Oct 12', 'Oct 12, 2025'
```

`unit` is the currency's ISO code under `currency` (default USD), else the text after the number. `duration` reads `value` in seconds.
A tone is the owner's meaning for that value: propane delivered is neutral, days between fills shrinking may be bad, income good;
nothing is green or red by itself. `Chart` takes the same units (`data.unit`, `costUnit`).

### Stat tiles

`StatTiles({tiles, onOpen, label})` (view/stat-tiles.js; `mountStatTiles(el, opts)`): a grid of label, figure and an optional delta.
`tiles: [{key, label, quantity | value (text), delta?, sub?, tip?, ref?}]`; a tile with a `ref` and an `onOpen` is a button.

```js
// propane, synthetic
tiles: [
  {key: 'delivered', label: 'Delivered, 12 months', quantity: {value: 612, unit: 'gal'},
    delta: delta({value: 612, unit: 'gal'}, {value: 540, unit: 'gal'}, {label: 'vs the 12 before'})},
  {key: 'tank', label: 'Tank now', quantity: {value: 38, format: 'percent', tone: 'bad'}, sub: 'about 19 days left'},
  {key: 'gap', label: 'Between fills', quantity: {value: 61 * 86400, format: 'duration'}, sub: 'average'},
  {key: 'paid', label: 'Paid', quantity: money(-1730.4)}]
```

### Rows, sections and figures

`RowList` (view/rows.js; `mountRows`) items take, beyond their lines: `quantity` (the trailing figure, tabular, in its tone, no chip; with
`delta` a second line under it), `glyph: null` (no tile) with `dot` (`accent`, `ok`, `warn`, `bad`, `sent`, `received`, `muted`: a small
category dot; a dot also sits beside the title of a row that keeps its tile), and `section: {key, label}` (consecutive items with one
key sit under a sticky heading; the option `sectionTotal(items, section)` returns a quantity or null for its right). `badge` and `end`
keep working.

```js
// a ledger: money rows under date sections
items: [{id: 't1', glyph: null, dot: 'accent', title: 'Corner Market', sub: 'Groceries', quantity: money(-42.5), section: dateSection('2026-10-15', now)},
        {id: 't2', glyph: null, dot: 'ok', title: 'Payroll', sub: 'Checking', quantity: money(2400), section: dateSection('2026-10-15', now)}]
sectionTotal: (items, section) => money(items.reduce((n, i) => n + i.quantity.value, 0))
// the same list for propane: a delivery a row, gallons trailing, the gap since the last fill as its delta
items: [{id: 'd1', glyph: 'document', title: 'Delivery', sub: 'Valley Propane', quantity: {value: 162.4, unit: 'gal'},
         delta: {text: '+61 days', tone: 'neutral', dir: 'up'}, section: {key: '2026', label: '2026'}}]
```

### Drawer

`Drawer({open, title, sub, onClose, children, label})` (view/drawer.js; `mountDrawer`): a modal dialog for one item's detail, a side
panel from 720px wide and a full sheet below; Esc, the close button or the scrim closes it, focus moves in and returns to what opened
it. `Facts({facts: [{label, quantity | value}]})` lays out its fields as a definition list, quantities formatted as above.

