# Charts — palette contract, form selection, mark specs, motion

Status: **partial** (#1445 Parts 1, 2 — including the owner-added sparkline variant — 3a, 3c and 4a–4e shipped: validated palette, scaffold chokepoint, CI palette validation, ramp exports, motion policy, guards. Part 3b — the slope/dumbbell, bullet-tile and dot-strip FORMS — is still unbuilt; the form table below marks them so.)

Charts are the app's densest surface and its easiest one to get quietly wrong. This page holds the rules; the one-line pointer stays in AGENTS.md's conventions.

The short version: **the color part is computable, so it is computed.** Nothing here asks anyone to eyeball a palette.

---

## 1. The palette contract

**One module owns every chart color: `lib/chart-colors.ts`.** Recharts, SVG and canvas take plain color strings, so a mark's color has to be a literal somewhere; that is the one place it may live. Two guards keep it that way, and they answer different questions:

| Guard                                     | Question it answers                                                                                   |
| ----------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| `lib/__tests__/chart-colors-scan.test.ts` | _Where_ may a color live? (no raw hex in `app/`/`components/`; no hand-rolled same-hue `bg-*` ladder) |
| `lib/__tests__/chart-palette.test.ts`     | Is the palette any _good_? (the six checks, computed)                                                 |

**Changing the palette means editing `lib/chart-colors.ts` and letting the validation test judge you.** `lib/chart-palette-validate.ts` is pure math — sRGB→OKLab/OKLCH, Machado CVD simulation at severity 1.0, WCAG contrast — and the test runs it over the real exports against both real chart surfaces (`#ffffff`, `#0f172a`). A failing edit prints the offending pair and its ΔE, not `expected true`.

The checks and their thresholds:

| Check               | Threshold                                                  | Why                                                                                                               |
| ------------------- | ---------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Lightness band      | OKLCH L in 0.43–0.77 (light) / 0.48–0.67 (dark)            | a mark outside its theme's band reads as washed out or muddy                                                      |
| Chroma floor        | OKLCH C ≥ 0.10                                             | below it a "hue" reads gray — the same visual class as gridlines, i.e. as chrome                                  |
| CVD separation      | adjacent-pair ΔE ≥ 8 (protan/deutan); 6–8 is a relief band | a dichromat reader has to tell neighbouring series apart                                                          |
| Normal-vision floor | worst-pair ΔE ≥ 15                                         | **hard gate.** Below it, full-color readers can't separate the pair either, and no amount of labelling fixes that |
| Contrast vs surface | ≥ 3:1                                                      | a mark has to be visible on the card it sits on                                                                   |

**Why this exists.** The #794 palette passed every guard the repo had and was still broken: the sky/cyan/teal→emerald hue-fold left `brand #16a34a` and `emerald #10b981` at ΔE **8.1** — the app's two most-used series colors, below the 15 floor — while the warm 500-steps sat at 2.5:1 and 2.2:1 on white and `slate` fell under the chroma floor. Arithmetic was the only thing that could have caught it. (#1445)

### The set

```
brand   #16a34a   brand-600    primary green
sky     #0284c7   sky-600      cool blue      (re-blessed for chart marks by #1445)
amber   #d97706   amber-600    warm
rose    #e11d48   rose-600     red/pink
violet  #8b5cf6   violet-500   purple
```

Five slots, **in fixed order**. A 6th series is not a generated hue — fold it into an explicit "other", facet it, or pick a different form.

`chartNeutral` (`#64748b`, slate-500) is **not** in the set. It fails the chroma floor, so as an Nth series it reads as scaffolding. Legitimate uses: chart chrome inside a hand-drawn SVG, and a bucket that genuinely means _other / none_.

**The one pair the checks let through, deliberately:** `brand` vs `rose` is ΔE 2.7 under deuteranopia. That is red-vs-green, no re-stepping fixes it, and both slots are load-bearing (the brand's own hue; the "out of range / missed" hue). They are legal only because of **mandatory secondary encoding** — see §4.

### Sequential cell ramps

Calendar heatmaps are charts whose cells are Tailwind **classes**, which is exactly how three hand-rolled `emerald-200/900` ladders drifted past a guard built to scan hex. So a ramp ships **both halves** — `stepClasses` (what renders) and per-theme hexes (what the validator checks) — and both move together:

- `chartActivityRamp` — brand green, 4 steps over a neutral empty cell. `WorkoutHeatmap`, `ActiveDaysStrip`.
- `chartAdherenceState` — `taken`/`partial` are two steps of the same brand ramp, `skipped` the neutral, `missed` the rose. `AdherenceCalendar`.

A ramp is validated as a ramp (`validateCellRamp`): one hue, monotone lightness, ΔL ≥ 0.06 between every neighbouring cell **including the empty one**, saturated end ≥ 3:1. The pale end is anchored to the ramp's own empty cell, not the card surface — in a grid, every cell's neighbour is another cell.

---

## 2. Choosing a form

| The data's job                                   | Form                                      | Component                                                |
| ------------------------------------------------ | ----------------------------------------- | -------------------------------------------------------- |
| a value over time                                | time series                               | `LineChartCard`                                          |
| a value over time, in a grid tile                | **sparkline** (`LineChartCard sparkline`) | `TrendMiniCard`                                          |
| two series compared over time                    | overlay on one time axis                  | `CompareChart`                                           |
| one analyte over time, against ranges            | banded time series                        | `BiomarkerChart`                                         |
| one metric, several reporting devices            | series-per-source                         | `SourceCompareChart`                                     |
| composition over time                            | stacked bars                              | `StackedBarCard`, `ZoneMinutesCard`                      |
| a relationship between two variables             | scatter                                   | `ScatterChartCard`                                       |
| consistency / "did I show up"                    | calendar heatmap                          | `WorkoutHeatmap`, `ActiveDaysStrip`, `AdherenceCalendar` |
| growth against reference percentiles             | percentile bands + trajectory             | `GrowthChart`                                            |
| _panel before/after (not built — #1445 Part 3b)_ | _slope / dumbbell_                        | —                                                        |
| _actual vs target vs pace (not built)_           | _bullet tile_                             | —                                                        |
| _"what's my normal range" (not built)_           | _dot strip with a median marker_          | —                                                        |

**No dual axis without a unit difference.** Two y-scales make line crossings an artifact of the scale choice rather than a fact about the data. `CompareChart` already enforces this (#400): normalized mode and same-unit pairs share ONE axis; only genuinely different units get a second one, and the tab copy says so. Do not widen it.

**Rejected forms:** radar/spider for muscle coverage (small multiples of bars read better); any dual-axis expansion.

**A new chart surface composes an existing card.** `lib/__tests__/chart-scaffold-scan.test.ts` fails a `recharts` import outside the blessed card list — that list _is_ the form inventory. A genuinely new FORM registers there with a justification and gets a row above; "a line chart, but for my page" does not.

---

## 3. Mark specs — and the scaffold that owns them

**`components/chart-scaffold.tsx` is the chokepoint.** Every card consumes its prop bags; the conventions below are its defaults, not per-file copies. This is the point: eight cards each hand-copying `<CartesianGrid strokeDasharray="3 3">` is why the mark conventions could not be fixed once.

It exports **prop bags, not wrapper components** — recharts identifies children by component type, so a `<ChartGrid/>` wrapping a `<CartesianGrid/>` renders no grid at all. (`ChartLegend` is a real component only because it sits outside the recharts tree.)

| Decision         | Rule                                                                                                  | Export                   |
| ---------------- | ----------------------------------------------------------------------------------------------------- | ------------------------ |
| Grid             | horizontal-only, solid hairlines. Never a dashed both-axes grid — the loudest "default recharts" tell | `chartGridProps`         |
| Axes             | no tick marks, no spine; ticks at 11px in a **text** token                                            | `chartAxisProps`         |
| Dots             | off above 30 points; hollow (surface fill, colored stroke) where they stay                            | `chartLineDot`           |
| Hover dot        | r ≥ 4, present even when resting dots are off                                                         | `chartActiveDot`         |
| Label size       | **≥ 10px**, always                                                                                    | `CHART_LABEL_FONT_SIZE`  |
| Dashes           | a named vocabulary (annotation / reference / target / now / cursor), never a literal                  | `chartDash`              |
| Tooltip          | one surface, one type size, one hover duration                                                        | `chartTooltipProps`      |
| Stacked segments | 2px surface gap, so segments read as discrete quantities                                              | `chartStackSegmentProps` |
| Legend           | every ≥ 2-series chart has one                                                                        | `ChartLegend`            |

**Text wears text tokens, never the series color.** Including axis ticks on a dual-axis chart: identity belongs to the marks and the legend, and a tick painted in a series color is a number wearing a data color.

### The sparkline variant

**A mini tile is not a small chart — it is a different chart.** `TrendMiniCard` reused the full `LineChartCard` at `h-40`, so every Overview/Body tile carried a complete X+Y axis: 11px ticks and the margin reservations sized for a 256px-tall chart, squeezed into a tile ~150px wide on a 390px phone. The ticks collided and the plot — the only part carrying information — got what was left.

The variant is a flag on the same card (`sparkline`), never a sixth hand-styled chart:

- **Axes hidden, not removed.** They still SCALE the series; `hide` stops them painting _and_ stops them reserving space, which is the actual win at tile width.
- **No grid**, margins near-zero.
- **The numbers the axes supplied become inline text.** `TrendMiniCard` renders latest (in its header, with the change badge) plus low/high under the plot — legible at any width, which an 11px tick in a 150px box is not.
- **Hover survives.** The tooltip is how a sparkline reports a single point.

Hiding axes is the MINI-TILE decision, not a global one: a full-size chart keeps the axis a reader traces a value along. `e2e/trends-sparkline.mobile.spec.ts` pins both halves at 390px — no axis inside a tile, axes still present (and ticks still ≥ 10px) on a full-size chart.

---

## 4. Identity is never color-alone

A legend on every ≥ 2-series chart is not a nicety — it is the secondary encoding that makes `brand` vs `rose` legal at all (§1), and it is the same family of rule as #1220 (status never carried by color alone). Concretely:

- ≥ 2 series → `ChartLegend` (a colored dot + a label in ink).
- The adherence grid → per-cell `title`, a `data-state` attribute, and a counted text legend.
- A single-series chart needs no legend: its title names it.

---

## 5. Motion policy

Minimal and meaningful; a medical-data surface is not a place for decoration.

| Where                       | Duration              | Notes                                                                                                                                            |
| --------------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| Chart draw-in               | ~400ms ease-out       | **first mount only.** recharts' 1500ms default reads sluggish, and it replays on every data change — a range or tab switch must snap, not redraw |
| Hover (active dot, tooltip) | ~150ms ease-out       | `chartTooltipProps` + two rules in `globals.css` for what recharts styles in the DOM                                                             |
| Dashboard hero count-up     | 400ms, once, on mount | `CountUpNumber`, currently the steps tile only                                                                                                   |

**`prefers-reduced-motion: reduce` disables all of it** — `isAnimationActive={false}` through `useChartMotion()`, and the CSS transitions are dropped in a media query. (This settles #794's open 8d checkbox for the chart layer.)

`CountUpNumber` renders the FINAL value on the server and on the first client paint; the count-up is a client-only embellishment layered on afterwards, so no reader — human, screen reader, or test — ever sees a partial number. It is for a hero **count**, not a general number wrapper; don't wrap a value an exact-text assertion reads.

**Not doing:** animated gradients, perpetual pulsing on live values, per-point stagger.

---

## 6. The guards, and what each one catches

| Test                                        | Catches                                                                                                                                                               |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/__tests__/chart-palette.test.ts`       | a palette edit that breaks any of the six checks, in either theme; a ramp that stops reading as a ramp                                                                |
| `lib/__tests__/chart-colors-scan.test.ts`   | a raw hex in `app/`/`components/`; a hand-rolled same-hue `bg-*` ladder                                                                                               |
| `lib/__tests__/chart-scaffold-scan.test.ts` | a raw `strokeDasharray="…"`; a hand-built tooltip `contentStyle={{`; a `recharts` import outside the blessed cards; a card that imports recharts but not the scaffold |
| `lib/__tests__/micro-text-size.test.ts`     | `text-[9px]` **and** numeric `fontSize: 9`                                                                                                                            |

Hand-drawn fixed-viewBox SVG panels (`IntradayPanel`, `FeverChart`, `MuscleAnatomy`) are exempt from the px-denominated rules, with justification in each allowlist: their lengths are viewBox user units scaled by the container, so a px floor cannot be applied to them. They are still bound by the palette.

**Deliberately not doing:** pixel-diff screenshot testing. The repo prefers stable testids over brittle pixel assertions, and every guard above fails with an explanation.
