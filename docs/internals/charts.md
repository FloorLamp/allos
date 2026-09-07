# Charts

Compose existing chart cards and shared specifications. Keep data decisions in
`lib/`, chart specifications in the public cards, and drawing in the shared
renderers.

## Palette

[chart-colors.ts](../../lib/chart-colors.ts) owns chart colors, including SVG and
canvas marks and Tailwind cell palettes. Use `chartSeries` in its fixed order:
brand, sky, amber, rose, violet. For more than five series, combine an explicit
“other” category, use facets, or choose another form. `chartNeutral` is for chrome
and categories meaning other/none, not an extra series hue. Labels use text tokens.

[chart-palette-validate.ts](../../lib/chart-palette-validate.ts) owns the computed
light/dark thresholds for lightness, chroma, contrast, normal-vision separation,
and color-vision-deficiency separation. Change the palette at its owner and run
`chart-palette.test.ts`; do not duplicate hex values or validator thresholds here.
Brand/rose requires secondary encoding because hue alone cannot distinguish that
pair for every reader. Every multi-series chart needs a labeled `ChartLegend`;
a single-series chart can use its title.

Use the declared cell palettes:

- `chartActivityRamp` for activity density; `chartObservationRamp` for recorded
  observations. Ramps carry both rendered classes and per-theme colors, with
  monotone lightness and sufficient separation from the empty cell.
- `chartAdherenceState` for taken/partial/skipped/missed. Cells also carry a title,
  `data-state`, and a counted text legend.
- `chartActivityTypeBlock` for categorical activity kinds. A category grid uses
  distinct series colors, not a same-hue quantity ramp.

Keep each palette's classes and validated colors in agreement.

## Choose an existing form

| Question                              | Public component                                  |
| ------------------------------------- | ------------------------------------------------- |
| Value over time                       | `LineChartCard`                                   |
| Compact level or daily quantity       | `TrendMiniCard`: line sparkline or `BarSparkline` |
| Two series over time                  | `CompareChart`                                    |
| Analyte against ranges                | `BiomarkerChart`                                  |
| Reporting-device comparison           | `SourceCompareChart`                              |
| Composition over time                 | `StackedBarCard`, `ZoneMinutesCard`               |
| Two-variable relationship             | `ScatterChartCard`                                |
| Attendance or adherence               | `ActiveDaysStrip`, `AdherenceCalendar`            |
| Sessions by day and kind              | `WeekSpine`                                       |
| Coverage and composition by group/day | `DayHistory`                                      |
| Growth trajectory and percentiles     | `GrowthChart`                                     |
| One day's clock layers                | `IntradayChart` via `IntradayPanel`               |
| Episode temperature and doses         | `illness/FeverChart`                              |

Same-unit and normalized comparisons share one y-axis. `CompareChart` permits a
second axis only for genuinely different units and explains that mode. Do not
expand dual-axis use or use radar charts for muscle coverage.

A new page composes a card or specification. A genuinely new form needs its own
justification and an update to the form inventory in `chart-scaffold-scan.test.ts`.
Slope/dumbbell, bullet-tile, and dot-strip forms remain unbuilt.

## Specifications and rendering

[chart-spec.ts](../../components/chart-spec.ts) owns plain-data specifications.
They name marks; they must not import React/Recharts runtime code, carry scaffold
prop bags, or contain render functions. Public cards build the specs before the
code-split rendering boundary.

| Renderer                | Consumers                                              |
| ----------------------- | ------------------------------------------------------ |
| `TimeSeriesChartInner`  | Line, biomarker, comparison, growth, source comparison |
| `BarSeriesChartInner`   | Stacked bars, zone minutes, bar sparklines             |
| `ScatterChartCardInner` | Scatter                                                |

`TimeSeriesChart` and `BarSeriesChart` own their dynamic boundaries and
height-matched loading/offline placeholders. Reuse those boundaries.

The x-axis kind states its meaning:

- `day`: calendar categories, with a required gap declaration or `{ none: true }`.
- `instant`: epoch positions proportional to elapsed time.
- `numeric`: another numeric domain, such as age in months, with caller labels.
- `category`: non-day categories, such as weeks.

[chart-scaffold.tsx](../../components/chart-scaffold.tsx) resolves specifications
into Recharts prop bags. Use bags on the real Recharts elements; wrapper components
can prevent child-type recognition. `ChartLegend` sits outside that tree.

The scaffold owns these drawing rules:

| Mark               | Rule                                                                                                               |
| ------------------ | ------------------------------------------------------------------------------------------------------------------ |
| Grid and curves    | Horizontal solid hairlines; straight segments, not interpolating splines.                                          |
| Axes               | No tick marks/spines; text-token labels.                                                                           |
| Dots               | Suppress dense-series resting dots; retain isolated readings and hover dots. Count real readings, not filled days. |
| Exactness          | Exact readings are solid with a surface ring; bounded/inexact readings are hollow.                                 |
| Sparse series      | Prominent solid dots with a thinner, fainter, dashed connecting stroke.                                            |
| Stacked bars       | Surface gaps separate segments.                                                                                    |
| References         | Named `event`, `window`, `unlogged`, `now`, `target`, and `band` marks.                                            |
| Dashes and tooltip | Shared `chartDash` and tooltip props.                                                                              |

[chart-time-axis.ts](../../lib/chart-time-axis.ts) owns value-axis step snapping
and calendar ticks. Day ticks walk backward from the window's final day, including
an unlogged final day. Use `TrendMetricMeta.domain` for genuinely bounded scales;
`trendMetricChartScale` applies it. Do not invent bounds for unbounded measures.

Linked charts use `LineChartCard`'s `syncId`/`syncMethod`. Different sample rates
need nearest-time synchronization rather than array indices.
`onActiveLabelChange` supports companions such as route markers.

## Card layout and navigation

[ChartCard](../../components/ChartCard.tsx) owns the header link, plot footprint,
and footer band. The header links to detail; the plot remains outside the link so
touch can inspect a point. `detailHref` is required. A `null` destination needs a
same-line `detail-none: <why>` comment. Use `metricDetailHref` for metric detail,
`clinicalResultDetailHref` for clinical readings, and the existing full-depth
surface for aggregate charts.

The plot is square below `sm` and uses `plotHeightClass` above it. Loading/error
states share that footprint. A direct `EmptyState` child releases the empty plot's
height. Use `CHART_PLOT_FILL` for a necessary inner wrapper, not another fixed
height. `about` explains the card; `note` describes current data.

Charts submit caption descriptors through
[ChartCaptionBand](../../components/ChartCaptionBand.tsx). The card renders
captions, footer, and footer action with one spacing owner; children add no top
margin. A live-outage caption can expose “Fix a range” through `fixRangeField`.

## Series states and gaps

[trend-sparkline.ts](../../lib/trend-sparkline.ts) owns mark shape, gap policy,
continuity spans, and maximum gap lengths on the shared `metric:`/`result:` keys.
Pages consume these decisions instead of choosing their own.

| Gap policy  | Meaning                                                                                 |
| ----------- | --------------------------------------------------------------------------------------- |
| `bridge`    | A level exists between samples; fill missing days with nulls, subject to the gap limit. |
| `break`     | Missing daily/nightly readings break the stroke.                                        |
| `slot-zero` | A missing daily total really is zero, such as training on a rest day.                   |
| `slot-null` | A daily total was not measured, including missing steps or nutrition logs.              |
| `exempt`    | No day filling, such as sparse lab-result series.                                       |

[day-fill.ts](../../lib/day-fill.ts) preserves calendar spacing. Trim leading empty
days, retain trailing days through the requested end, and keep an empty series
empty. All-time ranges end at their last reading. Beyond `MAX_FILL_DAYS`, return
the raw series instead of truncating it. A null tooltip says “No data”; zero-filled
days show zero. Never coerce null to zero. Numeric time axes, event axes, intraday
slots, and already-filled weeks use their own spacing; day-chart opt-outs state a
`gap-exempt:` reason.

`LineChartCard` applies shared preparation before building its spec:

- `loneReading` counts non-null points and selects `SingleReadingMark`. Use “Single
  reading” inside the window and “Latest recorded” for an older carried reading.
- Sparklines hide axes and grid while retaining scaling and tooltips; the tile
  supplies latest/low/high text. Daily quantities use the declared bar form.
- `aggregateLongRange` in [long-range-series.ts](../../lib/long-range-series.ts)
  selects calendar-week/month means only when span and occupied-bucket density
  warrant it. Show the low–high band, bucket tooltip labels, and aggregation caption
  on full charts. Preserve empty buckets and snap annotations to bucket starts.
- `sparseSeriesVerdict` uses median intervals, not readings-per-year. It draws the
  weaker stroke and a factual count/span caption without moving or dropping points.
  Continuity spans cannot fall below presentation floors. Aggregated plots and
  non-`gapFill` callers do not receive this treatment.
- Partial daily aggregates draw hollow, end the stroke before the incomplete day,
  and label the headline “so far today”. A completed point measurement taken today
  is not partial. Old headlines use the shared [freshness](freshness.md) as-of rule.

## Hand-drawn SVG and motion

Intraday, fever, Standing, and equipment sparklines retain their hand-drawn SVG
forms. Reuse data policy and [chart-svg.ts](../../lib/chart-svg.ts) geometry rather
than rebuilding them as generic charts.

For fixed-viewBox text, use `viewBoxFontSize` with the narrowest container:
`fontSize × minContainerPx / viewBoxWidth` must meet `MIN_LABEL_PX` (9px).
Recharts labels use `CHART_LABEL_FONT_SIZE` (10px). Cap overly wide panels too.
`clampLabel` elides and anchors inward; `placeRowLabels` omits lower-priority
collisions rather than shrinking below the floor.

Standing sparklines use existing domain reads and shared age tone. Their desktop
column disappears below 720px; facts remain. A family's drawing belongs to the
family, not one member. Full-width figures appear at every viewport and declare
`{ node, door }`; a member already linking there carries the family surface.
Drawing presence must not determine family presence.

Intraday scrub/zoom retains server-rendered SVG and pre-hydration fragment links.
Use the shared layout projection for chart and interaction coordinates. Zoom is
ephemeral; day-entry chips encode the chosen window only when followed. Fetch fine
samples only for the zoomed window; the full-day view retains the coarse envelope.

`useChartMotion` allows a short first-mount draw and hover transition. Range/data
changes snap to the new state. Reduced-motion preference disables animation and
transitions. Do not add pulsing, animated gradients, or per-point staggering.

## Verification

Use existing palette, scaffold, chart-tree, day-fill, sparse-series, and SVG tests
for their respective behavior. Browser checks cover touch inspection, sizing, and
SVG text containment (`expectSvgTextInsidePlot`). Follow the shared
[test policy](../change-policy.md): verify the changed behavior without adding
source-wording tests or automatically changing assertions for CSS edits.
