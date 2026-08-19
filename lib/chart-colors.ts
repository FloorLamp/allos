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

import type { ActivityType } from "./types/training"; // type-only: erased, no cycle

/** Muscle-anatomy coverage uses the Botanical accent through the shared CSS token. */
export const chartMuscleRamp = {
  fill: "var(--color-brand-600)",
} as const;

// Categorical series palette — pick distinct entries for a multi-series chart.
// Five slots, in fixed order; a hue is never generated for an Nth series.
export const chartSeries = {
  brand: "#16a34a", // brand-600  — primary green
  // sky-600 — cool blue. Re-blessed as a chart-series hue by #1445; the #794
  // fold had collapsed sky/cyan/teal into emerald, which cost the palette its
  // only cool tone and produced the two near-identical greens.
  sky: "#0284c7",
  // Warm yellow-orange (absorbs orange). Re-stepped a hair below amber-600:
  // Botanical's light card surface is slightly darker than white, and #d97706
  // fell to 2.96:1 there. #d47506 clears 3:1 on both Botanical surfaces while
  // holding the amber↔rose deutan pair at the 8.0 target.
  amber: "#d47506",
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
  /** Theme-aware foreground per level (empty, then 1…N). */
  labelClasses: readonly string[];
  /** The same ladder as hexes, per theme, for the CI palette validation. */
  light: {
    empty: string;
    steps: readonly string[];
    labelText: readonly string[];
  };
  dark: {
    empty: string;
    steps: readonly string[];
    labelText: readonly string[];
  };
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
  labelClasses: [
    "text-slate-800 dark:text-slate-100",
    "text-slate-950 dark:text-white",
    "text-slate-950 dark:text-white",
    "text-slate-950 dark:text-slate-950",
    "text-slate-950 dark:text-slate-950",
  ],
  light: {
    empty: "#ecf2e8",
    steps: ["#86efac", "#4ade80", "#22c55e", "#16a34a"],
    labelText: ["#1e3226", "#0c1710", "#0c1710", "#0c1710", "#0c1710"],
  },
  dark: {
    empty: "#141c16",
    steps: ["#166534", "#15803d", "#16a34a", "#22c55e"],
    labelText: ["#ecf2e8", "#ffffff", "#ffffff", "#0c1710", "#0c1710"],
  },
};

/** Observational quantity density — deliberately vivid royal blue rather than the
 *  brand green. Food servings and confirmed doses describe what was recorded;
 *  a darker cell must not imply that more is healthier or more adherent. */
export const chartObservationRamp: CellRamp = {
  emptyClass: "bg-slate-100 dark:bg-ink-800",
  stepClasses: [
    "bg-blue-200 dark:bg-blue-700",
    "bg-blue-300 dark:bg-blue-500",
    "bg-blue-400 dark:bg-blue-300",
    "bg-blue-600 dark:bg-blue-100",
  ],
  labelClasses: [
    "text-slate-800 dark:text-slate-100",
    "text-slate-950 dark:text-white",
    "text-slate-950 dark:text-slate-950",
    "text-slate-950 dark:text-slate-950",
    "text-white dark:text-slate-950",
  ],
  light: {
    empty: "#ecf2e8",
    steps: ["#bfdbfe", "#93c5fd", "#60a5fa", "#2563eb"],
    labelText: ["#1e3226", "#0c1710", "#0c1710", "#0c1710", "#ffffff"],
  },
  dark: {
    empty: "#141c16",
    steps: ["#1d4ed8", "#3b82f6", "#93c5fd", "#dbeafe"],
    labelText: ["#ecf2e8", "#ffffff", "#0c1710", "#0c1710", "#0c1710"],
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
    light: "#15803d",
    dark: "#22c55e",
  },
  partial: {
    class: "bg-brand-300 text-brand-900 dark:bg-brand-800 dark:text-brand-100",
    light: "#86efac",
    dark: "#166534",
  },
  skipped: {
    // slate-400, not the slate-300 this shipped with: against the pale `partial`
    // green, slate-300 sat at ΔE 14.1 — under the normal-vision floor, i.e. two
    // adjacent cells in the same grid that a full-color reader could not
    // confidently separate. One step darker clears it at 21.8.
    class: "bg-slate-400 text-slate-900 dark:bg-ink-700 dark:text-slate-200",
    light: "#86a190",
    dark: "#263129",
  },
  missed: {
    class: "bg-rose-600 text-white dark:bg-rose-500 dark:text-rose-950",
    light: "#e11d48", // rose-600
    dark: "#f43f5e", // rose-500
  },
  // Today, still unresolved (#2796). Deliberately UNFILLED: a pending day has no
  // outcome to color, and giving it a fill would put it back in the same visual class
  // as the settled states it is precisely not one of. The ring keeps it legible as a
  // real day of the month, which is what separates it from `na`'s off-cadence blank.
  // No light/dark hex because there is no fill for the palette test to separate.
  pending: {
    class:
      "bg-transparent text-slate-600 ring-1 ring-inset ring-slate-400 dark:text-slate-300 dark:ring-slate-600",
    light: null,
    dark: null,
  },
  na: {
    class: "bg-transparent text-slate-500 dark:text-slate-400",
    light: null,
    dark: null,
  },
} as const;

// ── Activity TYPE, as a categorical block color (#2566's week spine) ─────────
//
// The week spine stacks one block per logged session on each day of the week, colored
// by the session's `ActivityType`. That is a CATEGORICAL job, not a density ramp: the
// question is "what kind of session", never "how much", so it draws from the validated
// `chartSeries` set rather than from a same-hue ladder.
//
// The three hues a reader already associates with these types are kept — the Training
// Log's own type badges are violet/rose/sky for strength/cardio/sport — so the band
// reads against the log beside it instead of teaching a second color language. The two
// types the badge map never had get the remaining answers rather than a fall-through:
// mobility takes the brand green (its own surface, #840), and `unclassified` takes the
// explicitly-labeled NEUTRAL, exactly as `chartSleepStage.awake` does. A slate block
// says "the source did not say what this was" (#2272) instead of asserting a
// discipline the row never stated.
//
// Exhaustive `Record<ActivityType, …>` by the #2272 tuple discipline: a sixth activity
// type must declare its block here before the app compiles. Each entry ships the
// Tailwind class the DOM actually renders AND the hex it equals, so the palette
// validation has something to check and the two halves cannot drift.
export interface ActivityTypeBlockColor {
  /** The class the rendered block carries (theme-neutral mid-shade, as validated). */
  blockClass: string;
  /** The same color as a hex — what the CVD/contrast checks read. */
  hex: string;
}

export const chartActivityTypeBlock: Record<
  ActivityType,
  ActivityTypeBlockColor
> = {
  strength: { blockClass: "bg-violet-500", hex: chartSeries.violet },
  cardio: { blockClass: "bg-rose-600", hex: chartSeries.rose },
  sport: { blockClass: "bg-sky-600", hex: chartSeries.sky },
  mobility: { blockClass: "bg-brand-600", hex: chartSeries.brand },
  unclassified: { blockClass: "bg-slate-500", hex: chartNeutral },
};

// ── Fiber × GI read-together strip (#2788) ───────────────────────────────────
//
// The strip's two marks, declared here so the classes the DOM renders and the hexes
// the validation reads cannot drift (the chartActivityTypeBlock pattern — the class
// scan cannot see a Tailwind class, which is exactly how hand-rolled emerald bars
// would dodge every guard). The BAR takes `chartSeries.sky` — the same hue the
// Macros & fiber chart plots its fiber series in, so the app's two fiber surfaces
// speak one color — and the DOT takes `chartSeries.amber` (amber-600; the amber-500
// step failed #1445's 3:1 contrast check, and emerald was folded out of the palette
// entirely).
export const chartFiberPanelMarks = {
  bar: { class: "bg-sky-600", hex: chartSeries.sky },
  symptomDot: { class: "bg-amber-600", hex: chartSeries.amber },
} as const;

// ── Bristol stool-form panel (#2785) ─────────────────────────────────────────
//
// ONE hue for all seven types, deliberately. The categorical set has five members
// and the scale has seven, so a per-type color would have to invent two — but the
// deeper reason is that the types are ORDINAL, not categorical: they are one axis
// from hard to liquid, and seven identities would say they are seven unrelated
// things. Height (the distribution) and vertical position (the strip) carry the
// scale; color carries only "this is a Bristol mark".
//
// Violet because the panel sits in the Body census beside the sky fiber series and
// the amber symptom dots, and a third surface reaching for either of those hues
// would claim a relationship none of them has.
export const chartBristolMarks = {
  bar: { class: "bg-violet-500", hex: chartSeries.violet },
  dot: { class: "bg-violet-500", hex: chartSeries.violet },
} as const;
