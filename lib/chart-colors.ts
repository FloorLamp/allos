// Single source of truth for chart SERIES / data-mark colors (issue #794).
//
// Recharts, SVG, and canvas take plain color strings — Tailwind's `dark:`
// variants and design-token classes can't reach an SVG `stroke`/`fill` — so a
// chart line's color has to be a literal hex somewhere. This module is that ONE
// place: every value below is a hex drawn from the app's blessed palette
// families (brand / emerald / amber / rose / violet / slate — see
// `tailwind.config.ts` and `app/globals.css`), each commented with its Tailwind
// name. Charts import these instead of hand-picking hex, so a series color can't
// drift off-palette (the #780 sky-vs-brand clash) and there's one knob to turn.
//
// Off-palette leaks (sky / indigo / teal / cyan / blue / raw red / orange) that
// used to appear as chart series were folded onto the nearest blessed hue here:
//   blue / indigo / purple  → violet
//   sky / cyan / teal        → emerald
//   orange                   → amber
//   red                      → rose
// so a chart keeps the same NUMBER of distinct hues while every hue is on-palette.
//
// Theme-neutral by design: these vivid mid-shades are legible on both the light
// and dark chart surfaces, matching how the call sites already passed one color
// for both themes. The axis / grid / tooltip SCAFFOLDING that genuinely needs
// light↔dark pairs lives in `components/useChartColors.ts`, not here.

// Categorical series palette — pick distinct entries for a multi-series chart.
export const chartSeries = {
  brand: "#16a34a", // brand-600  — primary green
  emerald: "#10b981", // emerald-500 — cool green (absorbs sky/cyan/teal)
  amber: "#f59e0b", // amber-500  — warm yellow-orange (absorbs orange)
  rose: "#f43f5e", // rose-500   — red/pink (absorbs raw red)
  violet: "#8b5cf6", // violet-500 — purple (absorbs blue/indigo)
  slate: "#64748b", // slate-500  — neutral
} as const;

// Biomarker reference-band fills (BiomarkerChart). The standard range shades in
// a neutral gray; the longevity-optimal range in green.
export const chartBand = {
  reference: "#94a3b8", // slate-400  — standard reference range
  optimal: "#059669", // emerald-600 — longevity-optimal range
} as const;

export type ChartSeriesToken = keyof typeof chartSeries;
