# Foundation

## Foundation

Every page shares one look (`view/foundation.css`, loaded by every mount; `tokens.css` is generated, this file is not). Tokens:
`--space-section` (24: between a page's sections and blocks) and `--space-item` (8: between the parts inside one), `--font-figure`
(22/26, the number to read first), `--font-figure-lg` (28/32), `--font-section` (a date or section heading), `--drawer-width`,
`--sticky-top` (set it where the page has a fixed bar above the sticky section headings). Tones are classes, never raw colours:
`tone-good` (`--ok`), `tone-bad` (`--bad`), `tone-neutral` (`--text`); a delta also carries an arrow, so no tone is colour alone.

### Page layout

Full pages use `view/page-header.js`'s `PageHeader({title, description, actions, tabs})`: one h1, a short description,
actions beside the title (wrapping on phones), and optional navigation (`inlineTabs` keeps view tabs beside the title). `base.css` owns the `.dk-page` column:
`--page-width: 1080px`, including 32px gutters (16px below 600px), centred; a workspace (Flightplan) adds `.dk-page-wide` for the
window's width. Pages set no width, gutter or title style of their own. The shell's document background fills the viewport.
Embedded rows and desktop palette panels keep their own layout.

### Quantity

Everything that shows a number takes a quantity, whatever it measures; money is one preset. `quantity.js` (no DOM), re-exported by
`mount.js`:

```js
quantity = {value, unit?, format?: 'number' | 'currency' | 'percent' | 'duration', precision?, sign?: 'auto' | 'always', tone?: 'good' | 'bad' | 'neutral'}
formatQuantity({value: 7.4, unit: 'gal'})               // '7.4 gal'; {value: 62, format: 'percent'} → '62%'; {value: 276000, format: 'duration'} → '3d 4h' (seconds)
money(-42.5, {currency?, tone?})                        // the preset: currency, sign 'always', tone good when positive (money in), else neutral → '−$42.50', '+$1,200.00'
moneyText('231.36 USD')                                 // an amount as a source wrote it ('$11,200.00', 'USD 12', '($42.00)') → a currency quantity, else null → '$231.36'
delta(q, from, {label?, higher, pct?})                  // → {text: '+2 gal', pct: '+17%', tone, dir, label}; `higher`: what more means ('good', 'bad', 'neutral')
toneFor(value, higher)                                  // the tone of a signed value, for a quantity's own `tone`
moneyText('25 USD')                                      // money however a backend sent it (number, {amount, currency}, '25 USD') → '$25.00'
durationText(290), timecodeText(192)                     // '4m 50s'; a media clock '3:12'
```

`unit` is the currency's ISO code under `currency` (default USD), else the text after the number. `duration` reads `value` in seconds.
A tone is the owner's meaning for that value: propane delivered is neutral, days between fills shrinking may be bad, income good;
nothing is green or red by itself. `Chart` takes the same units (`data.unit`, `costUnit`).

### Format

Every date, time, count, name and label a view shows comes from `format.js` (no DOM), numbers and money from `quantity.js`;
a view never calls `toLocale…String`, `Intl` or builds a plural itself. `mount.js` re-exports `dateSection`.

```js
dateText('2026-10-15'), dateText(at, {now, weekday, timeZone})   // 'Oct 15, 2026'; 'Oct 15' when now is that year; 'Thu, Oct 15, 2026'
dateRange('2025-07-31', '2025-08-05')                    // 'Jul 31–Aug 5, 2025', 'Aug 1–5, 2025', 'Dec 30, 2025–Jan 2, 2026', 'Jul–Sep 2025'
timeText(at, {timeZone, seconds, compact, zone})         // '3:40 PM', '3:40:12 PM', '9 AM', '3:40 PM EDT'
dateTimeText(at, {now, timeZone, zone})                  // 'Oct 15, 2026, 3:40 PM'
relativeDay(day, today), dateSection(day, now)           // 'Today', 'Tomorrow', 'Yesterday', 'Monday' (the coming week), 'Mon, Oct 12'
listWhen(at, now)                                        // '9:05 AM' / 'Yesterday' / 'Monday' / 'Jun 20, 2025'
age(at, now)                                             // 'now', '5 min', '3 h', 'yesterday', 'Mon', 'Oct 2'; ahead 'in 5 min', 'in 3 h', 'tomorrow'
ago(at, now)                                             // 'just now', '5 min ago', '2 hours ago' (90 min, rounded), '2 weeks ago'; ahead 'in 7 hours', 'in 3 days'
plural(n, one, many?), countText(n), joinText(parts)     // '1 test', '1,201 rows'; '1,200'; parts joined by ' · ', empty ones dropped
initials(name), fieldLabel(key)                          // 'Sam (plumber)' → 'S', never a digit ('Example person 0001' → 'EP'); 'serial_number' → 'Serial number', 'locked' → 'Locked'
readableDates(text)                                      // '2026-07-31 Registration' → 'Jul 31, 2026 Registration' (bridge's titles and lines)
```

A calendar day (`YYYY-MM-DD`) never shifts with the zone; a moment reads in `timeZone`, else the device's; bridge's SQLite stamp
(`YYYY-MM-DD HH:MM:SS`, no zone) is UTC. `age` and `ago` round and read a moment ahead of `now` forward; within 45 s either side
(two clocks' skew) it is `now` / `just now`.

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
key sit under a sticky heading; the option `sectionTotal(items, section)` returns a quantity or null for its right), `tip` (the whole
text: the row's title and accessible name), `oneLine` (never wraps, a phone's too: an ellipsis) and `age` (when: the trailing meta).
`badge` and `end` keep working. Chips, pills and notes hold one line (base.css, palette.css): longer text gets an ellipsis, never a taller
shape.

Find's Asked lately (view/sections/asks.js) is a section of the palette's landing card: the page hands bridge's `/api/asks` list to
`mountPalette(…).asks(list)`; one-line rows (one per question, the ask glyph, when asked), five then the section's
`All n ›`; a click or Enter asks it again (`onAsk(question)` hears it).

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


### Menu

`Menu({items, label, onClose, opener, class})` (view/menu.js): the one menu button popup (Flightplan's Snooze, a House tile's More, the
viewer's More), rendered while open beside its `aria-haspopup="menu"` button. `items` `[{key, label, hint?, glyph?, class?, checked?, disabled?, run}]`
(`checked`: a `menuitemcheckbox`). Opening focuses the first item; ↓/↑ move, wrapping past disabled or hidden items; Home/End the ends; Esc closes
it before the page's own Esc, focus back on `opener` (a ref; else what had focus); Tab and a press outside close it. An item closes the
menu, focus back on its button, then runs.

### Chip group

`ChipGroup({options, value, onChange, label, toggle, disabled, class, groupRef})` (view/chip-group.js): a segmented control, toggle
chips (`aria-pressed`, one pressed) in a labelled group. `options` `[{value, label, title?, class?, disabled?}]`; `toggle`: pressing the
pressed chip lets it go (`onChange(null)`). Tab reaches each chip; ←/→ (and ↑/↓) move between them, wrapping; Home/End; Enter or Space
presses. `RangeChips({range, onRange, ranges, label})`: its preset for a chart's range ending now (`RANGES`: `24h`, `7d`, `30d`, `1y`;
each chip titled `The last 7 days`), none past one range.

### Toast

`Toast({outcome, status, host})` (view/toast.js): the one outcome over the page's foot (`role="status"`), `outcome`
`{text, bad?, actions?: [{label, run, disabled?}]}` or null; `status`: a failure links Service status. `useOutcome(ms = 4000)` →
`[outcome, say(text, bad, actions)]`, an outcome the view owns; `useFading(outcome, ms = 4000)`: a model's that never ends itself,
shown until `ms` after it appeared (while it has actions, as long as the model keeps them).
