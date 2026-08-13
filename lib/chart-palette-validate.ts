// Computable validation for the chart palette (issue #1445, Part 4a).
//
// `lib/__tests__/chart-colors-scan.test.ts` guards WHERE a chart color lives; it
// cannot say whether the palette is any GOOD. Nothing stopped `chartSeries` from
// being edited back into the two near-identical greens it shipped with (brand
// `#16a34a` vs emerald `#10b981` — OKLab ΔE 8.1, below the 15 floor where even
// full-color vision separates a pair). So palette validity is COMPUTED in CI
// instead of pinned by hand: this module is the pure math, and
// `lib/__tests__/chart-palette.test.ts` runs it over the real exports against
// both real chart surfaces.
//
// The checks and their thresholds are the standard data-viz palette checks:
// OKLCH lightness band per theme, OKLCH chroma floor, colorblind (CVD) ΔE
// separation between adjacent slots, a normal-vision ΔE floor, and WCAG contrast
// against the chart surface. ΔE throughout is Euclidean distance in OKLab ×100.
//
// Pure: no DB, no network, no DOM — it takes hex strings and returns numbers.

// ── thresholds ──────────────────────────────────────────────────────────────

/** OKLCH lightness band a categorical series color must sit inside, per theme. */
export const LIGHTNESS_BAND = {
  light: [0.43, 0.77],
  dark: [0.48, 0.67],
} as const;

/** OKLCH chroma floor. Below it a "hue" reads as gray — i.e. as chrome, not data.
 *  This is the check slate `#64748b` (C 0.041) failed, which is why slate is no
 *  longer a member of the categorical set. */
export const CHROMA_FLOOR = 0.1;

/** Adjacent-pair ΔE under simulated protanopia/deuteranopia. `TARGET` is the
 *  pass line; `FLOOR` is the relief band, legal ONLY where the surface carries
 *  mandatory secondary encoding (a text legend, per-cell labels, a data
 *  attribute) so identity is never color-alone. */
export const CVD_TARGET = 8.0;
export const CVD_FLOOR = 6.0;

/** Worst adjacent-pair ΔE under UNSIMULATED vision. A hard gate: below this,
 *  readers with full color vision cannot tell the pair apart either, and
 *  secondary encoding does not excuse it. */
export const NORMAL_FLOOR = 15.0;

/** WCAG contrast a data mark must clear against its chart surface. */
export const CONTRAST_MIN = 3.0;

/** Minimum OKLCH lightness gap between adjacent steps of a sequential ramp
 *  (including the empty/base cell), so neighbouring cells stay separable. */
export const RAMP_MIN_DELTA_L = 0.06;

/** Maximum OKLCH hue spread across a sequential ramp's colored steps. A wider
 *  spread means it is not a one-hue ramp — it is a categorical set pretending. */
export const RAMP_MAX_HUE_SPREAD = 40;

/** The two real chart surfaces the app renders marks against: the BASE
 *  palette's card surfaces (Botanical, `app/globals.css` --surface). The other
 *  appearance palettes' surfaces live in lib/chart-colors.ts PALETTES and are
 *  validated by the 3-palette × 2-mode matrix in chart-palette.test.ts (#2701). */
export const CHART_SURFACE = {
  light: "#f4f8f0",
  dark: "#101711",
} as const;

export type ChartTheme = keyof typeof CHART_SURFACE;

/** Machado, Oliveira & Fernandes (2009) CVD transforms at severity 1.0, applied
 *  in LINEAR RGB. The thresholds above are calibrated to this simulation, so
 *  swapping the model (Viénot, Brettel) would move borderline pairs. */
const MACHADO = {
  protan: [
    [0.152286, 1.052583, -0.204868],
    [0.114503, 0.786281, 0.099216],
    [-0.003882, -0.048116, 1.051998],
  ],
  deutan: [
    [0.367322, 0.860646, -0.227968],
    [0.280085, 0.672501, 0.047413],
    [-0.01182, 0.04294, 0.968881],
  ],
  tritan: [
    [1.255528, -0.076749, -0.178779],
    [-0.078411, 0.930809, 0.147602],
    [0.004733, 0.691367, 0.3039],
  ],
} as const;

export type CvdKind = keyof typeof MACHADO;

// ── color conversions ───────────────────────────────────────────────────────

type Triple = [number, number, number];

/** Parse `#rrggbb` (or bare `rrggbb`) to sRGB 0–1. Throws on anything else —
 *  an unparsed color would otherwise propagate NaN and fail the checks OPEN. */
export function hexToSrgb(hex: string): Triple {
  const h = hex.trim().replace(/^#/, "");
  if (!/^[0-9a-fA-F]{6}$/.test(h)) {
    throw new Error(
      `invalid hex color: ${JSON.stringify(hex)} (expected #rrggbb)`
    );
  }
  return [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255) as Triple;
}

const srgbToLinearChannel = (c: number): number =>
  c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;

/** sRGB hex → linear-light RGB. */
export function toLinearRgb(hex: string): Triple {
  return hexToSrgb(hex).map(srgbToLinearChannel) as Triple;
}

/**
 * Linear RGB → OKLab [L, a, b].
 *
 * The coefficients are Björn Ottosson's published OKLab matrices — fixed
 * mathematical constants, not data. Several of their digit runs happen to be
 * Luhn-valid, so phi-scan reads them as NPIs; each such line carries a
 * `phi-scan-ok` marker below.
 */
export function linearRgbToOklab([r, g, b]: Triple): Triple {
  const l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
  const m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
  const s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b); // phi-scan-ok: OKLab matrix constant
  return [
    0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s, // phi-scan-ok: OKLab matrix constant
    0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s, // phi-scan-ok: OKLab matrix constant
  ];
}

/** sRGB hex → OKLab. */
export function oklab(hex: string): Triple {
  return linearRgbToOklab(toLinearRgb(hex));
}

/** sRGB hex → OKLCH `{ l, c, h }` (hue in degrees, 0–360). */
export function oklch(hex: string): { l: number; c: number; h: number } {
  const [l, a, b] = oklab(hex);
  return {
    l,
    c: Math.hypot(a, b),
    h: ((((Math.atan2(b, a) * 180) / Math.PI) % 360) + 360) % 360,
  };
}

/** WCAG relative luminance of an sRGB hex. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = toLinearRgb(hex);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two sRGB hexes (order-independent, 1–21). */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort(
    (x, y) => y - x
  );
  return (hi + 0.05) / (lo + 0.05);
}

/** Simulate a dichromatic view of a color, in linear RGB. */
export function simulateCvd(hex: string, kind: CvdKind): Triple {
  const [r, g, b] = toLinearRgb(hex);
  const m = MACHADO[kind];
  const clamp = (c: number) => Math.max(0, Math.min(1, c));
  return [
    clamp(m[0][0] * r + m[0][1] * g + m[0][2] * b),
    clamp(m[1][0] * r + m[1][1] * g + m[1][2] * b),
    clamp(m[2][0] * r + m[2][1] * g + m[2][2] * b),
  ];
}

/** Euclidean OKLab distance ×100 between two hexes. Omit `kind` for normal
 *  (unsimulated) vision. */
export function deltaE(a: string, b: string, kind?: CvdKind): number {
  const x = linearRgbToOklab(kind ? simulateCvd(a, kind) : toLinearRgb(a));
  const y = linearRgbToOklab(kind ? simulateCvd(b, kind) : toLinearRgb(b));
  return 100 * Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
}

// ── checks ──────────────────────────────────────────────────────────────────

export type CheckState = "pass" | "warn" | "fail";

export interface PaletteCheck {
  name: string;
  state: CheckState;
  detail: string;
}

export interface PaletteReport {
  checks: PaletteCheck[];
  /** True when no check FAILed. WARN states (the CVD relief band, sub-3:1
   *  contrast relief) do not flip this — they oblige secondary encoding. */
  ok: boolean;
  failures: PaletteCheck[];
}

function adjacentPairs(n: number): [number, number][] {
  return Array.from(
    { length: Math.max(0, n - 1) },
    (_, i): [number, number] => [i, i + 1]
  );
}

function allPairs(n: number): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) out.push([i, j]);
  return out;
}

export interface CategoricalOptions {
  theme: ChartTheme;
  /** Defaults to the theme's real chart surface. */
  surface?: string;
  /** `adjacent` (lines/bars/stacks — the default) or `all` (scatter/maps, where
   *  any two slots can end up side by side). */
  pairs?: "adjacent" | "all";
}

/**
 * Validate a CATEGORICAL palette (the `chartSeries` set): distinct identities,
 * no ordering implied. Returns every check with its numbers so a failing test
 * message names the offending pair and its ΔE rather than just "expected true".
 */
export function validateCategoricalPalette(
  palette: readonly string[],
  {
    theme,
    surface = CHART_SURFACE[theme],
    pairs = "adjacent",
  }: CategoricalOptions
): PaletteReport {
  const checks: PaletteCheck[] = [];
  const [lo, hi] = LIGHTNESS_BAND[theme];

  const offBand = palette
    .map((c) => [c, oklch(c).l] as const)
    .filter(([, l]) => l < lo || l > hi);
  checks.push({
    name: "Lightness band",
    state: offBand.length ? "fail" : "pass",
    detail: offBand.length
      ? `outside L ${lo}–${hi} (${theme}): ${offBand
          .map(([c, l]) => `${c} L=${l.toFixed(3)}`)
          .join(", ")}`
      : `all ${palette.length} inside L ${lo}–${hi}`,
  });

  const lowChroma = palette
    .map((c) => [c, oklch(c).c] as const)
    .filter(([, c]) => c < CHROMA_FLOOR);
  checks.push({
    name: "Chroma floor",
    state: lowChroma.length ? "fail" : "pass",
    detail: lowChroma.length
      ? `below C ${CHROMA_FLOOR} (reads gray, i.e. as chrome not data): ${lowChroma
          .map(([c, v]) => `${c} C=${v.toFixed(3)}`)
          .join(", ")}`
      : `all ${palette.length} >= ${CHROMA_FLOOR}`,
  });

  const pairList =
    pairs === "all" ? allPairs(palette.length) : adjacentPairs(palette.length);

  let worstCvd: { d: number; kind: CvdKind; a: string; b: string } | null =
    null;
  for (const kind of ["protan", "deutan"] as const) {
    for (const [i, j] of pairList) {
      const d = deltaE(palette[i], palette[j], kind);
      if (!worstCvd || d < worstCvd.d)
        worstCvd = { d, kind, a: palette[i], b: palette[j] };
    }
  }
  const cvdState: CheckState = !worstCvd
    ? "pass"
    : worstCvd.d >= CVD_TARGET
      ? "pass"
      : worstCvd.d >= CVD_FLOOR
        ? "warn"
        : "fail";
  checks.push({
    name: "CVD separation",
    state: cvdState,
    detail: worstCvd
      ? `worst ${pairs} pair ${worstCvd.a}↔${worstCvd.b} ΔE ${worstCvd.d.toFixed(1)} (${worstCvd.kind}); target ${CVD_TARGET}, relief floor ${CVD_FLOOR}`
      : "n/a (fewer than 2 slots)",
  });

  let worstNormal: { d: number; a: string; b: string } | null = null;
  for (const [i, j] of pairList) {
    const d = deltaE(palette[i], palette[j]);
    if (!worstNormal || d < worstNormal.d)
      worstNormal = { d, a: palette[i], b: palette[j] };
  }
  checks.push({
    name: "Normal-vision floor",
    state: !worstNormal || worstNormal.d >= NORMAL_FLOOR ? "pass" : "fail",
    detail: worstNormal
      ? `worst ${pairs} pair ${worstNormal.a}↔${worstNormal.b} ΔE ${worstNormal.d.toFixed(1)} (normal vision); floor ${NORMAL_FLOOR}`
      : "n/a (fewer than 2 slots)",
  });

  const lowContrast = palette
    .map((c) => [c, contrastRatio(c, surface)] as const)
    .filter(([, r]) => r < CONTRAST_MIN);
  checks.push({
    name: "Contrast vs surface",
    state: lowContrast.length ? "fail" : "pass",
    detail: lowContrast.length
      ? `below ${CONTRAST_MIN}:1 vs ${surface}: ${lowContrast
          .map(([c, r]) => `${c} ${r.toFixed(2)}:1`)
          .join(", ")}`
      : `all ${palette.length} >= ${CONTRAST_MIN}:1 vs ${surface}`,
  });

  const failures = checks.filter((c) => c.state === "fail");
  return { checks, ok: failures.length === 0, failures };
}

export interface CellRampOptions {
  theme: ChartTheme;
  surface?: string;
  /** The ramp's empty/zero cell (e.g. the heatmap's "no workouts" square). It is
   *  part of the ladder — level 1 has to separate from EMPTY, not from the page
   *  surface, because that is the neighbour it actually sits beside. */
  empty?: string;
}

/**
 * Validate a SEQUENTIAL cell ramp (the heatmap / active-days density ramp): one
 * hue, monotone lightness, visible gaps between neighbouring steps, and a
 * saturated end that still reads as a mark on the surface.
 *
 * The categorical checks would fail a correct ramp BY DESIGN (a ramp spans the
 * lightness band on purpose, and its pale steps sit under the chroma floor), so
 * ramps get their own checks. The one deliberate difference from a generic
 * ordinal check: the pale end is anchored to the ramp's own EMPTY cell rather
 * than to the card surface, because in a calendar grid every cell's neighbour is
 * another cell — "level 1 vs no data" is the discrimination that matters, and
 * both squares are the same size and shape.
 */
export function validateCellRamp(
  steps: readonly string[],
  { theme, surface = CHART_SURFACE[theme], empty }: CellRampOptions
): PaletteReport {
  const checks: PaletteCheck[] = [];
  const ladder = empty ? [empty, ...steps] : [...steps];
  const ls = ladder.map((c) => oklch(c).l);

  // In the light theme the ladder runs light→dark as density rises; in the dark
  // theme it runs dark→light. Either way it must be strictly monotone.
  const wantDescending = theme === "light";
  const monotone = ls.every(
    (l, i) => i === 0 || (wantDescending ? l < ls[i - 1] : l > ls[i - 1])
  );
  checks.push({
    name: "Lightness monotone",
    state: monotone ? "pass" : "fail",
    detail: monotone
      ? `steps read ${wantDescending ? "light→dark" : "dark→light"} (${theme})`
      : `not monotone (${theme}): ${ladder
          .map((c, i) => `${c} L=${ls[i].toFixed(3)}`)
          .join(" → ")}`,
  });

  const thin = ls
    .slice(1)
    .map((l, i) => ({
      a: ladder[i],
      b: ladder[i + 1],
      gap: Math.abs(l - ls[i]),
    }))
    .filter(({ gap }) => gap < RAMP_MIN_DELTA_L);
  checks.push({
    name: "Adjacent ΔL",
    state: thin.length ? "fail" : "pass",
    detail: thin.length
      ? `steps too close to separate: ${thin
          .map(({ a, b, gap }) => `${a}↔${b} ΔL=${gap.toFixed(3)}`)
          .join(", ")}; floor ${RAMP_MIN_DELTA_L}`
      : `all ${ls.length - 1} gaps >= ${RAMP_MIN_DELTA_L}`,
  });

  // Hue spread over the COLORED steps only — the empty cell is deliberately a
  // neutral from a different family, so including it would always fail.
  const hues = steps.map((c) => oklch(c).h);
  let spread = hues.length ? Math.max(...hues) - Math.min(...hues) : 0;
  if (spread > 180) spread = 360 - spread;
  checks.push({
    name: "Single hue",
    state: spread <= RAMP_MAX_HUE_SPREAD ? "pass" : "fail",
    detail: `hue spread ${spread.toFixed(0)}° (max ${RAMP_MAX_HUE_SPREAD}°)`,
  });

  // The ramp's most-saturated end is a real data mark and clears the surface
  // like any other mark would.
  const strong = steps[steps.length - 1];
  const strongRatio = strong ? contrastRatio(strong, surface) : 0;
  checks.push({
    name: "Strong-end contrast",
    state: strongRatio >= CONTRAST_MIN ? "pass" : "fail",
    detail: `${strong} at ${strongRatio.toFixed(2)}:1 vs ${surface} (min ${CONTRAST_MIN}:1)`,
  });

  const failures = checks.filter((c) => c.state === "fail");
  return { checks, ok: failures.length === 0, failures };
}

/** Render a report as a readable block, used as the assertion message so a
 *  failing palette edit explains itself instead of printing `false`. */
export function formatReport(label: string, report: PaletteReport): string {
  const rows = report.checks
    .map(
      (c) =>
        `  [${c.state.toUpperCase().padEnd(4)}] ${c.name.padEnd(22)} ${c.detail}`
    )
    .join("\n");
  return `${label}\n${rows}`;
}
