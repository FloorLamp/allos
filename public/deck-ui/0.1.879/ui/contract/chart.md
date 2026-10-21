# Chart

## Chart

`view/chart.js` `Chart({data, onOpen, label, readout, timeZone})`: one measure over periods, whatever backend serves it (bridge's utility usage and a
vendor's invoices through `bridge.usage`, its find's topics; purser's spending by month next). The palette shows it above a series group's rows when
`bridge.usage` answers one, and above a topic's (`topic.chart`, from `bridge.find`).

```js
data = {title?, unit,                  // the measure's unit: 'kWh', 'gal', 'USD'
  valueName?: 'Usage', costName?: 'Cost', costUnit?: 'USD', rateUnit?,   // rateUnit: what `rate` is in ('¢/kWh', '$/gal', '$/1,000 gal')
  points: [{period, value, unit?, cost?, rate?, ref?, label?, start?, end?, part?}],   // period 'YYYY', 'YYYY-MM', 'YYYY-MM-DD' or 'YYYY-MM-DDTHH', one grain; value null: not read
  parts?: [{name}],                    // the series points belong to (a topic's accounts), `part` its index; several in a period stack
  gaps?: [period],                     // periods with nothing (a bill missing): hatched, "No bill"
  extra?: [{name, unit, points: [{period, value, partial?}]}],        // up to 2 more series in `unit` (lines): the Envoy's import, export
  zero?: false,                        // readings without a meaningful zero (a temperature): the axis spans them, bars rise from its floor, the legend alone names the unit
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
  period of points, gaps and extra. Months: from the records after the last empty stretch of 12 months or more when fewer came
  before it (one old bill never stretches the axis over years), at most as many months as get 14 px each (never fewer than 12); a
  line under the plot counts the months not drawn and Show all draws every one; scales and the legend cover only what is drawn (an
  account without a drawn bar has no legend entry). Months too thin to name show years alone; a January's label and year keep the
  others clear. Daily periods are calendar dates; hourly periods
  are UTC hours (00–23), with no offset or minutes in the key. All points, gaps and extra use the same grain. Day/hour bins span
  month and year boundaries; hourly bins are independent of local timezone and DST. Axis labels thin to fit; hourly labels show
  month/day at the start and at labelled local midnights. `timeZone` (Chart's prop; the House passes the house's) is the zone hourly
  periods read in, everywhere (axis, readout, accessible table), in Deck's clock style (`quantity.js` `timeText`/`dateText`): `10 PM`,
  `Thu 4 AM`; default the browser's, never UTC. `stats` remains optional and
  retains its monthly/yearly meaning.
- Hover (mouse) or a tap shows a period's values (each part's, its `rate`) in a readout under the plot, never over it, names and
  filenames whole; it stays on the last period until another is chosen. `readout: 'legend'` (a fixed-height board: the House
  tablet) puts it over the legend line instead, so nothing moves. A mouse click on a period with one `ref`, or the readout's
  Open, calls `onOpen(ref)` (the palette: viewed as a found document). A cost with no usage (a maintenance invoice) is a hollow cost
  dot, named in the legend. A hidden table holds the same numbers, every period's; colours from tokens.css (both themes, forced colours).
- `stats` (the backend computes them from the same points): tiles over the chart (last 12 months against the 12 before, the average
  a month, delivery or invoice, the cost of a unit, highest and lowest (a click opens it), gaps when given, the meter) and a table of calendar years under it.
  Tiles fill whole rows (six: two rows of three; a phone two a row); the year table's columns are even, and under 600 px each year
  is a block of labelled values.

