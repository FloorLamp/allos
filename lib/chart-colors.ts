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

// ── The appearance palettes (#2701) ──────────────────────────────────────────
//
// The heatmap/adherence cells are Tailwind CLASSES (bg-brand-300, bg-slate-100…)
// and the appearance palettes re-point those ramps under `[data-palette]` in
// app/globals.css — so the SAME class paints a different hex per palette. The
// validator therefore needs the per-palette token→hex map, and this table IS
// that map, mirroring globals.css's ramp blocks exactly. `botanical` is the
// base (no attribute); its column is also what the exported hex tables below
// are built from, so the base tables cannot drift from the map.
//
// Only the tokens this module's classes reference are listed. Tailwind ramps
// that no palette re-points (blue, rose-500/600, violet…) stay literal in the
// tables below and are palette-constant by construction.

export type AppearancePalette = "botanical" | "almanac" | "floodlight";

export const APPEARANCE_PALETTES: readonly AppearancePalette[] = [
  "botanical",
  "almanac",
  "floodlight",
];

export interface PaletteChartSpec {
  /** The card surface charts render against, per mode (globals.css --surface). */
  chartSurface: { light: string; dark: string };
  /** Token→hex for every re-pointed step a chart class references. */
  tokens: Record<string, string>;
}

export const PALETTES: Record<AppearancePalette, PaletteChartSpec> = {
  botanical: {
    chartSurface: { light: "#f4f8f0", dark: "#101711" },
    tokens: {
      "brand-100": "#dcfce7",
      "brand-300": "#86efac",
      "brand-400": "#4ade80",
      "brand-500": "#22c55e",
      "brand-600": "#16a34a",
      "brand-700": "#15803d",
      "brand-800": "#166534",
      "brand-900": "#14532d",
      "brand-950": "#052e16",
      "slate-100": "#ecf2e8",
      "slate-200": "#d9e8de",
      "slate-400": "#86a190",
      "slate-500": "#4e6354",
      "slate-800": "#1e3226",
      "slate-900": "#16281c",
      "slate-950": "#0c1710",
      "ink-700": "#263129",
      "ink-750": "#1a231d",
      "ink-800": "#141c16",
    },
  },
  almanac: {
    chartSurface: { light: "#fdfbf5", dark: "#131210" },
    tokens: {
      "brand-100": "#eef0da",
      "brand-300": "#cbd489",
      "brand-400": "#b0c452",
      "brand-500": "#8a9c33",
      "brand-600": "#647c15",
      "brand-700": "#52700f",
      "brand-800": "#3f6212",
      "brand-900": "#365314",
      "brand-950": "#1c2a08",
      "slate-100": "#f4f0e4",
      "slate-200": "#ece7d8",
      "slate-400": "#a09a84",
      "slate-500": "#6f6a54",
      "slate-800": "#2b2a20",
      "slate-900": "#221f16",
      "slate-950": "#12100a",
      "ink-700": "#2b2820",
      "ink-750": "#1f1c15",
      "ink-800": "#191712",
    },
  },
  floodlight: {
    chartSurface: { light: "#ffffff", dark: "#131312" },
    tokens: {
      "brand-100": "#fdf3d0",
      "brand-300": "#fcd34d",
      "brand-400": "#fbbf24",
      "brand-500": "#f59e0b",
      "brand-600": "#c2410c",
      "brand-700": "#9a3412",
      "brand-800": "#7c2d12",
      "brand-900": "#571c0a",
      "brand-950": "#431407",
      "slate-100": "#f0efe8",
      "slate-200": "#ebeae2",
      "slate-400": "#a3a299",
      "slate-500": "#6b6a62",
      "slate-800": "#1a1917",
      "slate-900": "#141412",
      "slate-950": "#0a0a09",
      "ink-700": "#2a2a26",
      "ink-750": "#1f1f1b",
      "ink-800": "#1a1a17",
    },
  },
};

/** Resolve a token name — or a literal that no palette re-points — to its hex
 *  under a palette. "white" is the one non-ramp name the ladders use. */
export function paletteHex(palette: AppearancePalette, token: string): string {
  if (token.startsWith("#")) return token;
  if (token === "white") return "#ffffff";
  const hex = PALETTES[palette].tokens[token];
  if (!hex) throw new Error(`paletteHex: unknown token "${token}"`);
  return hex;
}

// Base-palette shorthand for the exported hex tables below.
function t(token: string): string {
  return paletteHex("botanical", token);
}

/** The muscle-anatomy coverage ramp (#2701 sweep): the palette's own accent.
 *  The component paints the CSS var (palette-aware with no JS); the validator
 *  reads the per-palette hex through `paletteHex(p, chartMuscleRamp.token)`. */
export const chartMuscleRamp = {
  fill: "var(--color-brand-600)",
  token: "brand-600",
} as const;

// Categorical series palette — pick distinct entries for a multi-series chart.
// Five slots, in fixed order; a hue is never generated for an Nth series.
export const chartSeries = {
  brand: "#16a34a", // brand-600  — primary green
  // sky-600 — cool blue. Re-blessed as a chart-series hue by #1445; the #794
  // fold had collapsed sky/cyan/teal into emerald, which cost the palette its
  // only cool tone and produced the two near-identical greens.
  sky: "#0284c7",
  // Warm yellow-orange (absorbs orange). Re-stepped a hair below amber-600 for
  // #2701: the Botanical light card surface (#f4f8f0) is slightly darker than
  // the white it replaced, and #d97706 fell to 2.96:1 there. #d47506 clears
  // 3:1 on all six palette surfaces while holding the amber↔rose deutan pair
  // at the 8.0 target.
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
/** The token ladder behind a CellRamp's classes — what `cellRampHexes` resolves
 *  per palette, and what the exported base tables are built from, so the class
 *  half and the hex half cannot drift for ANY palette. */
export interface CellRampTokens {
  empty: { light: string; dark: string };
  steps: { light: readonly string[]; dark: readonly string[] };
  labelText: { light: readonly string[]; dark: readonly string[] };
}

function resolveRampSide(
  palette: AppearancePalette,
  tokens: CellRampTokens,
  side: "light" | "dark"
): { empty: string; steps: string[]; labelText: string[] } {
  return {
    empty: paletteHex(palette, tokens.empty[side]),
    steps: tokens.steps[side].map((s) => paletteHex(palette, s)),
    labelText: tokens.labelText[side].map((s) => paletteHex(palette, s)),
  };
}

/** The same ladder a CellRamp's classes paint, as hexes, under a palette —
 *  what the 3-palette × 2-mode validator matrix reads (#2701). */
export function cellRampHexes(
  tokens: CellRampTokens,
  palette: AppearancePalette
): { light: CellRamp["light"]; dark: CellRamp["dark"] } {
  return {
    light: resolveRampSide(palette, tokens, "light"),
    dark: resolveRampSide(palette, tokens, "dark"),
  };
}

export const chartActivityRampTokens: CellRampTokens = {
  empty: { light: "slate-100", dark: "ink-800" },
  steps: {
    light: ["brand-300", "brand-400", "brand-500", "brand-600"],
    dark: ["brand-800", "brand-700", "brand-600", "brand-500"],
  },
  labelText: {
    light: ["slate-800", "slate-950", "slate-950", "slate-950", "slate-950"],
    dark: ["slate-100", "white", "white", "slate-950", "slate-950"],
  },
};

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
  ...cellRampHexes(chartActivityRampTokens, "botanical"),
};

/** Observational quantity density — deliberately vivid royal blue rather than the
 *  brand green. Food servings and confirmed doses describe what was recorded;
 *  a darker cell must not imply that more is healthier or more adherent. */
export const chartObservationRampTokens: CellRampTokens = {
  empty: { light: "slate-100", dark: "ink-800" },
  // Blue is not re-pointed by any palette, so the steps are literals; only the
  // empty cell and the label text follow the palette.
  steps: {
    light: ["#bfdbfe", "#93c5fd", "#60a5fa", "#2563eb"],
    dark: ["#1d4ed8", "#3b82f6", "#93c5fd", "#dbeafe"],
  },
  labelText: {
    light: ["slate-800", "slate-950", "slate-950", "slate-950", "white"],
    dark: ["slate-100", "white", "slate-950", "slate-950", "slate-950"],
  },
};

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
  ...cellRampHexes(chartObservationRampTokens, "botanical"),
};

/** Medication-adherence cell states (`AdherenceCalendar`). `taken` and `partial`
 *  are two steps of the SAME brand ramp — partial is literally less of the same
 *  thing — while `skipped` (a deliberate non-dose) takes the neutral and `missed`
 *  the rose. Each cell also carries a title, a `data-state`, and a row in the
 *  calendar's text legend, so identity is never color-alone; that mandatory
 *  secondary encoding is what makes the green↔rose pair legal in the CVD relief
 *  band (ΔE 7.8 deutan), and the palette test pins it to that band. */
/** The adherence states' token pairs — resolved per palette by
 *  `adherenceHexes`, and into the exported base table below. Rose is not
 *  re-pointed at 500/600, so `missed` stays literal in every palette. */
export const chartAdherenceStateTokens = {
  taken: { light: "brand-700", dark: "brand-500" },
  partial: { light: "brand-300", dark: "brand-800" },
  skipped: { light: "slate-400", dark: "ink-700" },
  missed: { light: "#e11d48", dark: "#f43f5e" },
} as const;

export function adherenceHexes(
  palette: AppearancePalette
): Record<
  keyof typeof chartAdherenceStateTokens,
  { light: string; dark: string }
> {
  const out = {} as Record<
    keyof typeof chartAdherenceStateTokens,
    { light: string; dark: string }
  >;
  for (const [state, pair] of Object.entries(chartAdherenceStateTokens)) {
    out[state as keyof typeof chartAdherenceStateTokens] = {
      light: paletteHex(palette, pair.light),
      dark: paletteHex(palette, pair.dark),
    };
  }
  return out;
}

export const chartAdherenceState = {
  taken: {
    class: "bg-brand-700 text-white dark:bg-brand-500 dark:text-brand-950",
    light: t("brand-700"),
    dark: t("brand-500"),
  },
  partial: {
    class: "bg-brand-300 text-brand-900 dark:bg-brand-800 dark:text-brand-100",
    light: t("brand-300"),
    dark: t("brand-800"),
  },
  skipped: {
    // slate-400, not the slate-300 this shipped with: against the pale `partial`
    // green, slate-300 sat at ΔE 14.1 — under the normal-vision floor, i.e. two
    // adjacent cells in the same grid that a full-color reader could not
    // confidently separate. One step darker clears it at 21.8.
    class: "bg-slate-400 text-slate-900 dark:bg-ink-700 dark:text-slate-200",
    light: t("slate-400"),
    dark: t("ink-700"),
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
  recovery: { blockClass: "bg-brand-600", hex: chartSeries.brand },
  unclassified: { blockClass: "bg-slate-500", hex: chartNeutral },
};
