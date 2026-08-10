// Single source of truth for chart SERIES / data-mark colors (issue #794),
// re-validated and re-stepped by #1445.
//
// Recharts, SVG, and canvas take plain color strings — Tailwind's `dark:`
// variants and design-token classes can't reach an SVG `stroke`/`fill` — so a
// chart line's color has to be a literal hex somewhere. This module is that ONE
// place: charts import these instead of hand-picking hex, so a series color
// can't drift off-palette (the #780 sky-vs-brand clash) and there's one knob to
// turn.
//
// WHY THESE EXACT VALUES (#1445). The palette is no longer eyeballed: every
// export below is validated in CI by `lib/__tests__/chart-palette.test.ts` over
// the pure math in `lib/chart-palette-validate.ts` — OKLCH lightness band,
// chroma floor, colorblind (protan/deutan) ΔE separation, a normal-vision ΔE
// floor, and WCAG contrast — against BOTH real chart surfaces. Editing a value
// here without re-clearing those checks fails the build, with the offending pair
// and its ΔE in the message. The #794 set failed them: the sky/cyan/teal →
// emerald hue-fold left `brand #16a34a` and `emerald #10b981` at ΔE 8.1 (floor
// is 15 — the app's two most-used series colors were near-indistinguishable to
// FULL color vision), the warm 500-steps sat at 2.5:1 and 2.2:1 on white, and
// slate fell under the chroma floor, reading as scaffolding rather than data.
//
// Theme-neutral by design: these mid-shades clear every check on both the light
// and dark chart surfaces, matching how the call sites already passed one color
// for both themes. The axis / grid / tooltip SCAFFOLDING that genuinely needs
// light↔dark pairs lives in `components/useChartColors.ts`, not here; the mark
// styling that consumes both lives in `components/chart-scaffold.tsx`.
//
// See `docs/internals/charts.md` for the full contract.

// Categorical series palette — pick distinct entries for a multi-series chart.
// Five slots, in fixed order; a hue is never generated for an Nth series.
export const chartSeries = {
  brand: "#16a34a", // brand-600  — primary green
  // sky-600 — cool blue. Re-blessed as a chart-series hue by #1445; the #794
  // fold had collapsed sky/cyan/teal into emerald, which cost the palette its
  // only cool tone and produced the two near-identical greens.
  sky: "#0284c7",
  amber: "#d97706", // amber-600  — warm yellow-orange (absorbs orange)
  rose: "#e11d48", // rose-600   — red/pink (absorbs raw red)
  violet: "#8b5cf6", // violet-500 — purple (absorbs blue/indigo)
} as const;

// Explicitly-labeled neutral. NOT a member of the categorical set: it fails the
// chroma floor (OKLCH C 0.041), so as an Nth series it reads as chrome — the
// same visual class as gridlines and axis text. Legitimate uses are chart
// SCAFFOLDING inside a hand-drawn SVG (tick text, baselines) and a bucket that
// genuinely means "other / none", never a data series competing for identity.
export const chartNeutral = "#64748b"; // slate-500

// Biomarker reference-band fills (BiomarkerChart). The standard range shades in
// a neutral gray; the longevity-optimal range in green. These are TINTS (drawn
// at 0.08–0.15 fill opacity), so the categorical checks don't apply — but
// `optimal` also paints its band LABEL text, so it holds >= 3:1 on both surfaces
// (3.77:1 light, 4.74:1 dark) and the palette test pins that.
export const chartBand = {
  reference: "#94a3b8", // slate-400  — standard reference range (fill only, no label)
  optimal: "#059669", // emerald-600 — longevity-optimal range (fill + label text)
} as const;

export type ChartSeriesToken = keyof typeof chartSeries;

// Sleep-stage sub-band fills (issue #1068's intraday panel, and any later stage
// chart). A single-hue depth ramp on the blessed violet family — deep is the
// darkest, light the palest — with awake dropping to the neutral so it reads as
// "not asleep" rather than another depth. Lives here, beside the rest of the
// palette, so a second surface can't invent its own stage colors.
export const chartSleepStage = {
  deep: "#6d28d9", // violet-700
  rem: chartSeries.violet, // violet-500
  light: "#c4b5fd", // violet-300
  awake: chartNeutral, // slate-500 — explicitly "not a stage"
} as const;

// ── Sequential cell ramps (issue #1445, Part 3a/4d) ──────────────────────────
//
// The calendar surfaces (DayHistory, ActiveDaysStrip, medications'
// AdherenceCalendar) are charts too, but their cells are Tailwind CLASSES, not
// SVG fills — which is exactly how three hand-rolled `emerald-200/900` ramps
// drifted past the hex scan that guards the series palette. So the blessed ramp
// ships in BOTH shapes: `stepClasses` for the DOM cells (what the surfaces
// actually render) and `light`/`dark` hexes for the validator to check. Both
// halves move together, and `chart-colors-scan.test.ts` fails a surface that
// hand-rolls a same-hue `bg-*` ladder of its own again.
//
// A density ramp is a SEQUENTIAL job: one hue, light→dark (light theme) or
// dark→light (dark theme), with the zero/empty cell a neutral so "no data" never
// looks like "a little data".

export interface CellRamp {
  /** Tailwind classes for the zero/empty cell (both themes). */
  emptyClass: string;
  /** Tailwind classes per density step, level 1…N (both themes). */
  stepClasses: readonly string[];
  /** The same ladder as hexes, per theme, for the CI palette validation. */
  light: { empty: string; steps: readonly string[] };
  dark: { empty: string; steps: readonly string[] };
}

/** Workout/activity density — the brand green, since activity is the brand's own
 *  metric. Four steps (1, 2, 3, 4+ sessions) over a neutral empty cell.
 *  Consumed by `DayHistory` and `ActiveDaysStrip`. */
export const chartActivityRamp: CellRamp = {
  emptyClass: "bg-slate-100 dark:bg-ink-800",
  stepClasses: [
    "bg-brand-300 dark:bg-brand-800",
    "bg-brand-400 dark:bg-brand-700",
    "bg-brand-500 dark:bg-brand-600",
    "bg-brand-600 dark:bg-brand-500",
  ],
  light: {
    empty: "#f1f5f9", // slate-100
    steps: ["#86efac", "#4ade80", "#22c55e", "#16a34a"], // brand 300→600
  },
  dark: {
    empty: "#141a17", // ink-800
    steps: ["#166534", "#15803d", "#16a34a", "#22c55e"], // brand 800→500
  },
};

/** Medication-adherence cell states (`AdherenceCalendar`). `taken` and `partial`
 *  are two steps of the SAME brand ramp — partial is literally less of the same
 *  thing — while `skipped` (a deliberate non-dose) takes the neutral and `missed`
 *  the rose. Each cell also carries a title, a `data-state`, and a row in the
 *  calendar's text legend, so identity is never color-alone; that mandatory
 *  secondary encoding is what makes the green↔rose pair legal in the CVD relief
 *  band (ΔE 7.8 deutan), and the palette test pins it to that band. */
export const chartAdherenceState = {
  taken: {
    class: "bg-brand-700 text-white dark:bg-brand-500 dark:text-brand-950",
    light: "#15803d", // brand-700
    dark: "#22c55e", // brand-500
  },
  partial: {
    class: "bg-brand-300 text-brand-900 dark:bg-brand-800 dark:text-brand-100",
    light: "#86efac", // brand-300
    dark: "#166534", // brand-800
  },
  skipped: {
    // slate-400, not the slate-300 this shipped with: against the pale `partial`
    // green, slate-300 sat at ΔE 14.1 — under the normal-vision floor, i.e. two
    // adjacent cells in the same grid that a full-color reader could not
    // confidently separate. One step darker clears it at 21.8.
    class: "bg-slate-400 text-slate-900 dark:bg-ink-700 dark:text-slate-200",
    light: "#94a3b8", // slate-400
    dark: "#283029", // ink-700
  },
  missed: {
    class: "bg-rose-600 text-white dark:bg-rose-500 dark:text-rose-950",
    light: "#e11d48", // rose-600
    dark: "#f43f5e", // rose-500
  },
  na: {
    class: "bg-transparent text-slate-500 dark:text-slate-400",
    light: null,
    dark: null,
  },
} as const;
