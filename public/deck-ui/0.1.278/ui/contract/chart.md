# Chart

## Chart

`view/chart.js` `Chart({data, onOpen, label})`: one measure over periods, whatever backend serves it (bridge's utility usage and a
vendor's invoices through `bridge.usage`, its find's topics; purser's spending by month next). The palette shows it above a series group's rows when
`bridge.usage` answers one, and above a topic's (`topic.chart`, from `bridge.find`).

```js
data = {title?, unit,                  // the measure's unit: 'kWh', 'gal', 'USD'
  valueName?: 'Usage', costName?: 'Cost', costUnit?: 'USD', rateUnit?,   // rateUnit: what `rate` is in ('¢/kWh', '$/gal', '$/1,000 gal')
  points: [{period, value, unit?, cost?, rate?, ref?, label?, start?, end?, part?}],   // period 'YYYY', 'YYYY-MM', 'YYYY-MM-DD' or 'YYYY-MM-DDTHH', one grain; value null: not read
  parts?: [{name}],                    // the series points belong to (a topic's accounts), `part` its index; several in a period stack
  gaps?: [period],                     // periods with nothing (a bill missing): hatched, "No bill"
  extra?: [{name, unit, points: [{period, value, partial?}]}],        // up to 2 more series in `unit` (lines): the Envoy's import, export
  stats?: Stats}
Stats = {years: [{year, value, cost, count, months?, rate?}],         // calendar years: totals (null: none read), points, months covered
  last12: {from, to, value, cost, count, before: {from, to, value, cost, count} | null, change: {value, cost} | null},   // % change
  average: {per: 'month' | 'delivery' | 'invoice', value, cost},
  high: {period, value, ref} | null, low: {period, value, ref} | null,   // a period's usage, else (`valueName` 'Cost') its cost
  gaps?,                               // bills missing; absent: none counted (a vendor's invoices), no tile
  rate?: {unit, value, latest: {period, value} | null, basis: 'usage' | 'grid import'},   // the cost of a unit, overall and latest
  meter?: {years: [{year, import, export, net, months, partial?}], last12: {from, to, import, export, net, months, partial?}}}
```

- Bars for `value` (negative below zero; a part's colour each, stacked), `extra` as lines on the same axis; `cost` (a period's added
  up) a line in its own panel below on the same time axis (never a second scale on one panel). The bins run from the first to the last
  period of points, gaps and extra; months too thin to name show years alone. Daily periods are calendar dates; hourly periods
  are UTC hours (00–23), with no offset or minutes in the key. All points, gaps and extra use the same grain. Day/hour bins span
  month and year boundaries; hourly bins are independent of local timezone and DST. Axis labels thin to fit; hourly labels show
  month/day at the start and at labelled midnights, with full UTC dates in tooltips and the accessible table. `stats` remains optional and
  retains its monthly/yearly meaning.
- Hover (mouse) or a tap shows a period's values (each part's, its `rate`); a mouse click on a period with one `ref`, or the
  tooltip's Open, calls `onOpen(ref)` (the palette: viewed as a found document). A hidden table holds the same numbers; colours from
  tokens.css (both themes, forced colours).
- `stats` (the backend computes them from the same points): tiles over the chart (last 12 months against the 12 before, the average
  a month, delivery or invoice, the cost of a unit, highest and lowest (a click opens it), gaps when given, the meter) and a table of calendar years under it; two tiles a row
  on a phone, the table scrolling inside itself.

