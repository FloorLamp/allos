# Charts — palette contract, form selection, mark specs, motion

Status: **partial** (#1488's chart card + tap-through guard shipped; #1445 Parts
1, 2 — including the owner-added sparkline variant — 3a, 3c and 4a–4e shipped:
validated palette, scaffold chokepoint, CI palette validation, ramp exports,
motion policy, guards. Part 3b — the slope/dumbbell, bullet-tile and dot-strip
FORMS — is still unbuilt; the form table below marks them so.)

Charts are the app's densest surface and its easiest one to get quietly wrong.
This page holds the rules; the one-line pointer stays in AGENTS.md's
conventions.

The short version: **the color part is computable, so it is computed.** Nothing
here asks anyone to eyeball a palette.

---

## 1. The palette contract

**One module owns every chart color: `lib/chart-colors.ts`.** Recharts, SVG and
canvas take plain color strings, so a mark's color has to be a literal
somewhere; that is the one place it may live. Two guards keep it that way, and
they answer different questions:

| Guard                                     | Question it answers                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `lib/__tests__/chart-colors-scan.test.ts` | _Where_ may a color live? (no raw hex in `app/`/`components/`; no hand-rolled same-hue `bg-*` ladder) |
| `lib/__tests__/chart-palette.test.ts`     | Is the palette any _good_? (the six checks, computed)                                                 |

**Changing the palette means editing `lib/chart-colors.ts` and letting the
validation test judge you.** `lib/chart-palette-validate.ts` is pure math —
sRGB→OKLab/OKLCH, Machado CVD simulation at severity 1.0, WCAG contrast — and
the test runs it over the real exports against both real chart surfaces
(`#ffffff`, `#0f172a`). A failing edit prints the offending pair and its ΔE, not
`expected true`.

The checks and their thresholds:

| Check               | Threshold                                                  | Why                                                                                                               |
| ------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Lightness band      | OKLCH L in 0.43–0.77 (light) / 0.48–0.67 (dark)            | a mark outside its theme's band reads as washed out or muddy                                                      |
| Chroma floor        | OKLCH C ≥ 0.10                                             | below it a "hue" reads gray — the same visual class as gridlines, i.e. as chrome                                  |
| CVD separation      | adjacent-pair ΔE ≥ 8 (protan/deutan); 6–8 is a relief band | a dichromat reader has to tell neighbouring series apart                                                          |
| Normal-vision floor | worst-pair ΔE ≥ 15                                         | **hard gate.** Below it, full-color readers can't separate the pair either, and no amount of labelling fixes that |
| Contrast vs surface | ≥ 3:1                                                      | a mark has to be visible on the card it sits on                                                                   |

**Why this exists.** The #794 palette passed every guard the repo had and was
still broken: the sky/cyan/teal→emerald hue-fold left `brand #16a34a` and
`emerald #10b981` at ΔE **8.1** — the app's two most-used series colors, below
the 15 floor — while the warm 500-steps sat at 2.5:1 and 2.2:1 on white and
`slate` fell under the chroma floor. Arithmetic was the only thing that could
have caught it. (#1445)

### The set

```
brand   #16a34a   brand-600    primary green
sky     #0284c7   sky-600      cool blue      (re-blessed for chart marks by #1445)
amber   #d97706   amber-600    warm
rose    #e11d48   rose-600     red/pink
violet  #8b5cf6   violet-500   purple
```

Five slots, **in fixed order**. A 6th series is not a generated hue — fold it
into an explicit "other", facet it, or pick a different form.

`chartNeutral` (`#64748b`, slate-500) is **not** in the set. It fails the chroma
floor, so as an Nth series it reads as scaffolding. Legitimate uses: chart
chrome inside a hand-drawn SVG, and a bucket that genuinely means _other /
none_.

**The one pair the checks let through, deliberately:** `brand` vs `rose` is ΔE
2.7 under deuteranopia. That is red-vs-green, no re-stepping fixes it, and both
slots are load-bearing (the brand's own hue; the "out of range / missed" hue).
They are legal only because of **mandatory secondary encoding** — see §4.

### Sequential cell ramps

Calendar heatmaps are charts whose cells are Tailwind **classes**, which is
exactly how three hand-rolled `emerald-200/900` ladders drifted past a guard
built to scan hex. So a ramp ships **both halves** — `stepClasses` (what
renders) and per-theme hexes (what the validator checks) — and both move
together:

- `chartActivityRamp` — brand green, 4 steps over a neutral empty cell.
  `DayHistory`, `ActiveDaysStrip`.
- `chartAdherenceState` — `taken`/`partial` are two steps of the same brand
  ramp, `skipped` the neutral, `missed` the rose. `AdherenceCalendar`.

A ramp is validated as a ramp (`validateCellRamp`): one hue, monotone lightness,
ΔL ≥ 0.06 between every neighbouring cell **including the empty one**, saturated
end ≥ 3:1. The pale end is anchored to the ramp's own empty cell, not the card
surface — in a grid, every cell's neighbour is another cell.

---

## 2. Choosing a form

| The data's job                                   | Form                                      | Component                                           |
| ------------------------------------------------ | ----------------------------------------- | --------------------------------------------------- |
| a value over time                                | time series                               | `LineChartCard`                                     |
| a value over time, in a grid tile                | **sparkline** (`LineChartCard sparkline`) | `TrendMiniCard`                                     |
| a per-day QUANTITY, in a grid tile               | **bar sparkline**                         | `BarSparkline` (via `TrendMiniCard sparklineShape`) |
| two series compared over time                    | overlay on one time axis                  | `CompareChart`                                      |
| one analyte over time, against ranges            | banded time series                        | `BiomarkerChart`                                    |
| one metric, several reporting devices            | series-per-source                         | `SourceCompareChart`                                |
| composition over time                            | stacked bars                              | `StackedBarCard`, `ZoneMinutesCard`                 |
| a relationship between two variables             | scatter                                   | `ScatterChartCard`                                  |
| consistency / "did I show up"                    | calendar heatmap                          | `ActiveDaysStrip`, `AdherenceCalendar`              |
| coverage + composition, per group per day        | day-history calendar + group×day matrix   | `DayHistory` (over `lib/day-history.ts`)            |
| growth against reference percentiles             | percentile bands + trajectory             | `GrowthChart`                                       |
| ONE day, every layer, on a clock axis            | hand-drawn SVG day chart (scrub + zoom)   | `IntradayChart` (via `IntradayPanel`)               |
| an illness episode's temperature + doses         | hand-drawn SVG episode chart              | `illness/FeverChart`                                |
| _panel before/after (not built — #1445 Part 3b)_ | _slope / dumbbell_                        | —                                                   |
| _actual vs target vs pace (not built)_           | _bullet tile_                             | —                                                   |
| _"what's my normal range" (not built)_           | _dot strip with a median marker_          | —                                                   |

**No dual axis without a unit difference.** Two y-scales make line crossings an
artifact of the scale choice rather than a fact about the data. `CompareChart`
already enforces this (#400): normalized mode and same-unit pairs share ONE
axis; only genuinely different units get a second one, and the tab copy says so.
Do not widen it.

**Rejected forms:** radar/spider for muscle coverage (small multiples of bars
read better); any dual-axis expansion.

**A new chart surface composes an existing card.**
`lib/__tests__/chart-scaffold-scan.test.ts` fails a `recharts` import outside
the blessed card list — that list _is_ the form inventory. A genuinely new FORM
registers there with a justification and gets a row above; "a line chart, but
for my page" does not.

---

## 3. Mark specs — and the scaffold that owns them

**`components/chart-scaffold.tsx` is the chokepoint.** Every card consumes its
prop bags; the conventions below are its defaults, not per-file copies. This is
the point: eight cards each hand-copying `<CartesianGrid strokeDasharray="3 3">`
is why the mark conventions could not be fixed once.

It exports **prop bags, not wrapper components** — recharts identifies children
by component type, so a `<ChartGrid/>` wrapping a `<CartesianGrid/>` renders no
grid at all. (`ChartLegend` is a real component only because it sits outside the
recharts tree.)

| Decision         | Rule                                                                                                  | Export                   |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ------------------------ |
| Grid             | horizontal-only, solid hairlines. Never a dashed both-axes grid — the loudest "default recharts" tell | `chartGridProps`         |
| Axes             | no tick marks, no spine; ticks at 11px in a **text** token                                            | `chartAxisProps`         |
| Dots             | off above 30 points; hollow (surface fill, colored stroke) where they stay                            | `chartLineDot`           |
| Hover dot        | r ≥ 4, present even when resting dots are off                                                         | `chartActiveDot`         |
| Label size       | **≥ 10px**, always (a viewBox panel's floor is computed — §6)                                         | `CHART_LABEL_FONT_SIZE`  |
| Dashes           | a named vocabulary (annotation / reference / target / now / cursor), never a literal                  | `chartDash`              |
| Tooltip          | one surface, one type size, one hover duration                                                        | `chartTooltipProps`      |
| Stacked segments | 2px surface gap, so segments read as discrete quantities                                              | `chartStackSegmentProps` |
| Legend           | every ≥ 2-series chart has one                                                                        | `ChartLegend`            |

Linked charts use the shared `LineChartCard` `syncId`/`syncMethod` props. When
sample rates differ, the caller supplies a value-based nearest-time method; it
must not use array-index synchronization, which would align a one-minute stream
with the first minute of a one-second stream. `onActiveLabelChange` is the
supported escape hatch for a non-chart companion such as the ride route marker.

**Text wears text tokens, never the series color.** Including axis ticks on a
dual-axis chart: identity belongs to the marks and the legend, and a tick
painted in a series color is a number wearing a data color.

### The sparkline variant

**A mini tile is not a small chart — it is a different chart.** `TrendMiniCard`
reused the full `LineChartCard` at `h-40`, so every Overview/Body tile carried a
complete X+Y axis: 11px ticks and the margin reservations sized for a 256px-tall
chart, squeezed into a tile ~150px wide on a 390px phone. The ticks collided and
the plot — the only part carrying information — got what was left.

The variant is a flag on the same card (`sparkline`), never a sixth hand-styled
chart:

- **Axes hidden, not removed.** They still SCALE the series; `hide` stops them
  painting _and_ stops them reserving space, which is the actual win at tile
  width.
- **No grid**, margins near-zero.
- **The numbers the axes supplied become inline text.** `TrendMiniCard` renders
  latest (in its header, with the change badge) plus low/high under the plot —
  legible at any width, which an 11px tick in a 150px box is not.
- **Hover survives.** The tooltip is how a sparkline reports a single point.

**The MARK follows the data, not the tile (#1485 D).** A line asserts continuity
— the quantity existed between two readings and moved smoothly between them.
That is true of a level (weight, resting HR, an analyte: it has a value on the
days you did not sample it) and false of a per-day TOTAL whose missing days are
real zeros. Training volume is the second kind, and its line drew a slope across
rest days that had no training in them at all — a sawtooth that reads as noise
at tile width. So the sparkline has a bar twin (`BarSparkline`, registered in
the scan's form inventory), and **which series get it is one pure decision** —
`lib/trend-sparkline.ts`, keyed on the shared `metric:` / `bio:` series
vocabulary, with a short justified list rather than a runtime "does it
oscillate?" heuristic (a mark that changed shape as you moved the range would be
worse than one that is occasionally conservative). The mark's own styling is a
scaffold prop bag like every other (`chartSparklineBarProps`).

Hiding axes is the MINI-TILE decision, not a global one: a full-size chart keeps
the axis a reader traces a value along. `e2e/trends-sparkline.mobile.spec.ts`
pins both halves at 390px — no axis inside a tile, axes still present (and ticks
still ≥ 10px) on a full-size chart.

### Long ranges aggregate (#1938)

**A year of daily readings is not 365 marks.** Past ~6 months of span, a dense
series plots as calendar-bucket means — weekly, monthly past ~2 years — with the
bucket's low–high spread as a band behind the mean line, so day-to-day noise
becomes visible spread instead of the point-per-day scribble #1932 documents.
The decision and the computation are ONE pure function,
`aggregateLongRange` (`lib/long-range-series.ts`), applied inside
`LineChartCardInner` — the funnel every windowed line chart renders through — so
no surface can bucket the same series two ways:

- **Span picks the grain, density decides at all.** Spans ≤ 180 days (every
  short quick range) always plot raw; a long-span series under ~2 readings per
  occupied bucket (weekly weigh-ins, occasional labs) is already legible and
  stays raw too.
- **The chart says so.** An aggregated plot carries a caption
  ("Weekly averages · band shows each week's low–high",
  `data-testid="chart-long-range-note"`), its tooltip labels buckets
  ("Week of …" / "February 2026") and marks the series value "(avg)", and the
  band appears as a "Range" tooltip row. Sparklines aggregate for legibility but
  skip the caption — their numbers are the caller's inline text.
- **Buckets are calendar-anchored** (UTC calendar math from `lib/date.ts`), so
  a chart re-rendered tomorrow shifts by one bucket instead of re-cutting all
  of them; annotations snap onto the plotted bucket starts.

### Gaps (#2258)

**A missing day must occupy space.** recharts positions a category axis by array
INDEX, so a day-precision series that only carries the days it HAS a reading for
compresses its gaps away: a four-night sync outage plots as four adjacent,
evenly spaced points with the stroke bridging them — visually identical to four
consecutive nights. `lib/weekly-fill.ts` (#406) fixed exactly this for weekly
bars; `lib/day-fill.ts` is its day-grain twin.

**The fill helper's contract.** Given a dated series and a window,
`fillDailySeries` / `fillDailyRows` emit one entry per calendar day:

- **Leading empty days are TRIMMED.** The axis starts at the first reading — a
  90-day window opened before you owned a scale draws no two months of nothing.
- **Trailing days to the window's end are KEPT.** The run of nulls at the right
  edge IS the live-outage signal; trimming it back to the last reading is the
  lie this fix exists to remove. An all-time window (no `to`) ends at the last
  reading — its span is its data.
- An empty series stays empty (the card draws its empty state), and a span past
  `MAX_FILL_DAYS` degrades to the raw series rather than truncating one.

**The gap is a per-SERIES declaration, not a per-surface prop.** It lives beside
the mark decision in `lib/trend-sparkline.ts`, on the same `metric:` / `bio:`
vocabulary — the mark follows the data, and so does the gap. A surface passes
`gapFill={{ seriesKey, from, to }}`; the card looks the policy up. That is what
keeps the Body card, the tile and the metric detail page from disagreeing about
whether a missing steps day is a zero.

| Policy      | Fill   | Bridges? | Series                                                                                                                                                                                    |
| ----------- | ------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `bridge`    | `null` | yes      | LEVELS — weight, body fat, BMI, lean/bone mass, BMR, hydration, resting HR, HRV, skin-temp, daily HR, height, head and waist circumference, the clinical vitals, the 1–5 check-in ratings |
| `break`     | `null` | no       | per-night / per-day READINGS — sleep duration, sleep stages, sleep regularity, the Oura scores                                                                                            |
| `slot-zero` | `0`    | —        | per-day TOTALS whose missing day is a real zero — training volume (a rest day)                                                                                                            |
| `slot-null` | `null` | no       | per-day TOTALS that were NOT measured — steps, active calories, sun minutes, intake calories, macros/fiber                                                                                |
| `exempt`    | —      | —        | every `bio:` series: lab draws are sparse by nature, and 365 mostly-null categories around three draws degrade the tile for no honesty gain                                               |

A level bridges because the quantity exists on the days you didn't sample it;
what densification buys it is honest calendar-PROPORTIONAL spacing (two weigh-ins
a month apart stop rendering adjacent). A reading breaks because a missed night
is a real absence. A total slots because each day is its own quantity — and
whether the missing day is `0` or `null` is the difference between "rested" and
"not measured", which is why manually-logged nutrition totals fill `null`: a
zero there would assert a fast nobody recorded.

**Consequences the cards own:**

- **Dots count REAL readings, not calendar days.** `chartLineDot`'s
  `DENSE_SERIES_POINTS` threshold is fed `applyDayFill(...).realCount`; feeding
  it the densified length would silently drop the dots from a 90-day window
  holding 12 weigh-ins.
- **A gap day's tooltip says "No data".** recharts filters null payloads by
  default, which is why hovering an outage used to open an unlabelled empty box;
  the cards pass `filterNull={false}` and name the absence. `Number(null)` is
  `0`, so an unguarded formatter would print "0 steps" for a day the watch never
  reported. A zero-FILLED day still prints its real `0`.
- **Gaps survive aggregation.** `aggregateLongRange` emits a null bucket for an
  empty calendar week/month between occupied ones, so a six-week outage inside a
  1Y window does not bridge at bucket grain either. The density gate still counts
  OCCUPIED buckets only — a gapped series is judged on the data it has.
- **Annotation snapping becomes near-lossless.** Every calendar day is a real
  category now, so `snapAnnotationsToDates` / `snapWindowsToDates` stop drifting
  markers onto the nearest charted reading and stop collapsing short windows.

**Out of scope, and correct as-is:** intraday slot charts (already null-slotted
with `connectNulls={false}`), per-event x-axes (strength sessions, rides, cycles
— the index IS the event), week-grain charts already filled by
`lib/weekly-fill.ts`, and every chart already on the NUMERIC time axis — the
biomarker detail chart, `CompareChartInner` and `SourceCompareChartInner` all
pass `type="number" scale="time"`, so their x is already proportional to elapsed
time and there is nothing to densify. Each day-grain call site that opts out
carries a `// gap-exempt: <reason>` comment, which is what the scan below reads.

---

## 4. Identity is never color-alone

A legend on every ≥ 2-series chart is not a nicety — it is the secondary
encoding that makes `brand` vs `rose` legal at all (§1), and it is the same
family of rule as #1220 (status never carried by color alone). Concretely:

- ≥ 2 series → `ChartLegend` (a colored dot + a label in ink).
- The adherence grid → per-cell `title`, a `data-state` attribute, and a counted
  text legend.
- A single-series chart needs no legend: its title names it.

---

## 5. Motion policy

Minimal and meaningful; a medical-data surface is not a place for decoration.

| Where                       | Duration              | Notes                                                                                                                                            |
| --------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chart draw-in               | ~400ms ease-out       | **first mount only.** recharts' 1500ms default reads sluggish, and it replays on every data change — a range or tab switch must snap, not redraw |
| Hover (active dot, tooltip) | ~150ms ease-out       | `chartTooltipProps` + two rules in `globals.css` for what recharts styles in the DOM                                                             |
| Dashboard hero count-up     | 400ms, once, on mount | `CountUpNumber`, currently the steps tile only                                                                                                   |

**`prefers-reduced-motion: reduce` disables all of it** —
`isAnimationActive={false}` through `useChartMotion()`, and the CSS transitions
are dropped in a media query. (This settles #794's open 8d checkbox for the
chart layer.)

`CountUpNumber` renders the FINAL value on the server and on the first client
paint; the count-up is a client-only embellishment layered on afterwards, so no
reader — human, screen reader, or test — ever sees a partial number. It is for a
hero **count**, not a general number wrapper; don't wrap a value an exact-text
assertion reads.

**Not doing:** animated gradients, perpetual pulsing on live values, per-point
stagger.

---

## 5b. The card, and where a chart goes when you tap it

A full-size chart on Trends is not a picture — it is the way in. Every one
renders through `components/ChartCard.tsx` (issue #1488), which owns four things
at once:

- **The tap contract.** The header row — the title plus the latest-value
  headline — is a link to the chart's detail page, with a small expand icon
  top-right carrying an accessible name. The PLOT is never inside that link: on
  touch, tapping the plot is how a point is read, and that gesture must stay
  tooltip inspection. Anything that wraps a plot in an anchor has broken the
  chart.
- **`detailHref`, required.** `null` is allowed only with a same-line
  `detail-none: <why>` comment. The destination for a registered body metric is
  `metricDetailHref(slug)` → `/trends/metric/<slug>`; an aggregate/composite
  chart (training volume, macros, zone minutes) points at the existing
  full-depth surface its bars are summed from, named at the call site. A chart of
  a stored clinical READING (a biomarker or a vital) uses
  `readingDetailHref(canonicalName)` instead, which picks the surface by cadence
  (#1932) — never `metricDetailHref` directly, or the two link lanes could
  disagree about where one reading opens.
- **The plot height.** The card owns it — square below `sm`, `plotHeightClass`
  (default `sm:h-64`) above — through the `.chart-card-plot > *` rule in
  `app/globals.css`. A call site does not pass `heightClass`; that is what keeps
  every state of a card (populated, empty, loading, error, offline fallback) on
  one footprint, so a stack does not reflow because one series is empty.
- **Desktop is unchanged.** The square is a mobile-only rule; from `sm` up the
  card is exactly the proportions it had before, pinned by a browser test.

## 6. The guards, and what each one catches

| Test                                        | Catches                                                                                                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/__tests__/chart-palette.test.ts`       | a palette edit that breaks any of the six checks, in either theme; a ramp that stops reading as a ramp                                                                |
| `lib/__tests__/chart-colors-scan.test.ts`   | a raw hex in `app/`/`components/`; a hand-rolled same-hue `bg-*` ladder                                                                                               |
| `lib/__tests__/chart-scaffold-scan.test.ts` | a raw `strokeDasharray="…"`; a hand-built tooltip `contentStyle={{`; a `recharts` import outside the blessed cards; a card that imports recharts but not the scaffold |
| `lib/__tests__/micro-text-size.test.ts`     | `text-[9px]`, numeric `fontSize: 9`, **and** a viewBox size that _renders_ under 9px (below)                                                                          |
| `lib/__tests__/chart-detail-href.test.ts`   | a Trends chart drawn outside `ChartCard` (a dead end); a `detailHref={null}` with no `detail-none:` justification; a registry kind the detail page can't resolve      |
| `lib/__tests__/chart-svg.test.ts`           | the shared viewBox text math itself: the scale ratio, the computed floor, the label clamp and the row-collision rule                                                  |
| `lib/__tests__/day-fill-scan.test.ts`       | a day-grain chart card with neither `gapFill` nor a `gap-exempt:` reason; a metric with no declared gap policy; a stale registry entry                                |

### Hand-drawn fixed-viewBox panels get a COMPUTED floor, not an exemption

`IntradayChart`, `illness/FeverChart` and `MuscleAnatomy` draw their own SVG with
a fixed viewBox scaled to the container. Their lengths are user units, so a raw
`fontSize={7}` is genuinely not 7px — and for one release that observation bought
them a blanket exemption from the px rules. It was the wrong conclusion: the
exemption removed the only size guard from the charts whose type size is hardest
to reason about, and the intraday panel shipped **~3.5px** labels behind it (720
units into a 358px phone column is a factor of 0.497). (#1518)

The ratio is the whole difference, and the ratio is computable. Each panel now
declares its scale contract — its viewBox width and the **narrowest container it
renders into** — and the rule is:

```
fontSize × (minContainerPx ÷ viewBoxWidth) ≥ 9px
```

failing with the computed effective size ("fontSize 7 × 0.722 = 5.1px effective
at a 520px container, floor 9px"). The better way to satisfy it is not to raise a
literal but to stop writing one: `viewBoxFontSize({ viewBoxWidth, minContainerPx })`
in `lib/chart-svg.ts` returns the smallest size that clears the floor, so the
number in the source **is** the floor. All three panels take their size that way.

The floor is 9, not the 10 of `CHART_LABEL_FONT_SIZE`: a recharts label is DOM
text at a size the browser sets exactly, while a viewBox label lands wherever the
container puts it, so 9 is the "still readable at the narrowest" bound rather than
the design size. These panels remain bound by the palette.

**A panel whose type must stay in band needs a max width too.** Scaling cuts both
ways: the same 720-unit box that painted 3.5px labels on a phone painted ~17px
ones in the app's 110rem shell. `IntradayChart` caps each variant's width, which
is what keeps a computed floor from becoming a computed ceiling problem.

### Label placement inside a hand-drawn plot

`lib/chart-svg.ts` also owns where a label goes, because #1573 found annotation
labels the right SIZE painting off the plot and off the viewport (a right edge at
449px against a 390px viewport), and same-row labels stacking into a smear:

- `clampLabel` elides to the plot's width first (a clip-path alone would truncate
  mid-word and silently lie), then flips the anchor at an edge so the text paints
  **inward**, then shifts as a last resort.
- `placeRowLabels` lays out one baseline's worth of labels and **drops** the ones
  that would overlap, highest priority first. Dropping, not shrinking: shrinking
  walks back under the size floor above, and two half-legible labels answer no
  question.

`e2e/helpers.ts::expectSvgTextInsidePlot` is the browser half. The element-level
`expectNoClippedContent` walk does not catch this — SVG `<text>` overflowing its
own plot is invisible to a containment check on DOM boxes — so the SVG text guard
is a separate assertion, run on the surfaces that draw hand-rolled charts.

### Interactivity is a FORM decision (#1445), and here is the one justification

`IntradayChart` carries a scrub + zoom layer (#1515): pointer/keyboard crosshair
with a live-region readout, drag-to-select zoom to any window, tap-a-block to zoom
to it, and a per-minute refinement fetched for the zoomed window only. It is
listed here rather than sneaking in, and it holds the constraints that made the
panel static in the first place:

- **No loading box.** It is a `"use client"` component, which still renders on the
  SERVER — the complete chart is in the first HTML byte. What it is NOT is
  `dynamic(ssr: false)` + `ChartLoading`, which is what the recharts cards cost and
  what a glance surface rendered on every day view cannot spend.
- **No chart library.** The overlay is hand-written SVG over the same pure
  projection (`lib/intraday-layout.ts`) the base draws with — one `x(minute)`, not
  two that happen to line up.
- **Anchors survive.** Tick and block `<a href="#…">` fragments work before
  hydration and with JS off; the block's zoom is an `onClick` layered over the
  anchor, so the pre-hydration behavior is the fallback by construction.
- **Zoom is ephemeral.** No route param, no history entry: reload or back returns
  to the full day.

Per-minute data is deliberately NOT shipped for the whole day (the reason is in
`MAX_FINE_WINDOW_MINUTES`): at 0.47 units per minute it is sub-pixel and would be
downsampled again to draw, and nothing is hidden without it — each 5-minute point
carries `lo`/`hi` and the panel draws that envelope as a band.

**Deliberately not doing:** pixel-diff screenshot testing. The repo prefers
stable testids over brittle pixel assertions, and every guard above fails with
an explanation.
