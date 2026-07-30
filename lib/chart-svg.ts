// Text geometry for the app's HAND-DRAWN SVG charts — the shared half of issues
// #1518, #1573 and #1512.
//
// Three charts (`IntradayPanel`, `illness/FeverChart`, `MuscleAnatomy`) draw their
// own SVG with a fixed viewBox scaled to the container. That family kept asking the
// same two questions in three places, and getting them wrong in different ways:
//
//   1. HOW BIG is this label on a real phone? A `fontSize={7}` in a 720-unit box
//      rendered into a 358 px column paints at 7 × (358 ÷ 720) ≈ 3.5 CSS px. The
//      number in the source is NOT the number on the page, which is why the px
//      floor in `micro-text-size.test.ts` exempted these files outright — and why
//      the intraday panel shipped sub-4px labels behind that exemption (#1518).
//
//   2. WHERE does the label go? A label anchored at a mark near the plot's right
//      edge paints RIGHT and runs off the plot, off the card, and off the viewport
//      (#1573: a window label whose right edge landed at 449 px against a 390 px
//      viewport), and several labels on one row smear into each other.
//
// Both are arithmetic, so both are computed here, once, and the panels and the
// guard read the SAME functions. No DB, no DOM, no React: pure.

// ── 1. Effective size ────────────────────────────────────────────────────────

/**
 * The legibility floor for chart text, in REAL CSS pixels on the narrowest
 * container the app renders the chart in.
 *
 * 9, not the 10 of `CHART_LABEL_FONT_SIZE`: a recharts label is DOM text at a size
 * the browser sets exactly, while a viewBox label lands wherever the container
 * width puts it, so the viewBox floor is the "still readable" bound rather than
 * the design size. A panel that clears 9 at its narrowest sits comfortably above
 * 10 everywhere else. (#1518)
 */
export const MIN_LABEL_PX = 9;

/**
 * The narrowest content column the app renders a chart into: a 390 px phone
 * (the app's mobile baseline viewport) minus the shell and card padding. Panels
 * that are capped narrower than the column declare their own.
 */
export const MOBILE_CHART_CONTENT_PX = 358;

/** A fixed-viewBox panel's scale contract: how wide its box is in USER UNITS, and
 *  the narrowest CSS-pixel container it is allowed to render into. */
export interface ViewBoxScale {
  /** The panel's viewBox width, in user units. */
  viewBoxWidth: number;
  /** The narrowest rendered container width, in CSS px. */
  minContainerPx: number;
}

/** What one user unit is worth in CSS px at the narrowest container. */
export function viewBoxScale({
  viewBoxWidth,
  minContainerPx,
}: ViewBoxScale): number {
  if (!(viewBoxWidth > 0)) return 0;
  return minContainerPx / viewBoxWidth;
}

/** What a `fontSize={n}` in user units actually paints at, in CSS px. */
export function effectiveFontPx(fontSize: number, scale: ViewBoxScale): number {
  return fontSize * viewBoxScale(scale);
}

/**
 * The smallest user-unit font size that still clears `minPx` of real type at the
 * narrowest container — rounded UP to the nearest half unit so the answer is a
 * number a human can read in the source.
 *
 * This is the number a panel should USE, not a number it should be checked
 * against after the fact: `fontSize={intradayGeometry(...).labelSize}` cannot
 * drift below the floor the guard enforces, because it IS the floor.
 */
export function viewBoxFontSize(
  scale: ViewBoxScale,
  minPx: number = MIN_LABEL_PX
): number {
  const s = viewBoxScale(scale);
  if (!(s > 0)) return minPx;
  return Math.ceil((minPx / s) * 2) / 2;
}

// ── 2. Label layout ──────────────────────────────────────────────────────────

/**
 * Average glyph advance as a fraction of the font size, for the app's sans stack.
 *
 * SVG text has no server-side measurement, so a budget is an ESTIMATE. It is
 * deliberately generous (a digit is ~0.55em, a lowercase letter ~0.5em, an
 * uppercase ~0.68em): over-estimating a label's width elides one character too
 * early, while under-estimating paints past the plot — which is the bug (#1573).
 */
export const TEXT_ADVANCE_RATIO = 0.6;

/** The ellipsis a truncated label ends in — one glyph, counted as one advance. */
export const ELLIPSIS = "…";

/** Estimated painted width of `text` at `fontSize`, in the same units as fontSize. */
export function textWidth(text: string, fontSize: number): number {
  return text.length * fontSize * TEXT_ADVANCE_RATIO;
}

/**
 * `text` shortened until it fits `maxWidth`, ending in an ellipsis when anything
 * was dropped. Null when not even one character plus the ellipsis fits — the
 * caller then draws no label at all rather than a lone "…", which carries no
 * information and still costs a collision slot.
 */
export function elideToWidth(
  text: string,
  maxWidth: number,
  fontSize: number
): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;
  if (textWidth(trimmed, fontSize) <= maxWidth) return trimmed;
  const per = fontSize * TEXT_ADVANCE_RATIO;
  if (!(per > 0)) return null;
  // How many glyphs fit, one of which has to be the ellipsis.
  const fits = Math.floor(maxWidth / per) - 1;
  if (fits < 1) return null;
  return `${trimmed.slice(0, fits).trimEnd()}${ELLIPSIS}`;
}

export type SvgTextAnchor = "start" | "middle" | "end";

/** The painted [left, right] extent of a label drawn at `x` with `anchor`. */
export function textExtent(
  x: number,
  width: number,
  anchor: SvgTextAnchor
): { left: number; right: number } {
  const left =
    anchor === "start" ? x : anchor === "end" ? x - width : x - width / 2;
  return { left, right: left + width };
}

export interface LabelClampInput {
  /** Where the label WANTS to sit (the mark it annotates). */
  x: number;
  text: string;
  fontSize: number;
  /** The preferred anchor before edge handling. */
  anchor?: SvgTextAnchor;
  /** The plot's inner bounds, in user units. */
  left: number;
  right: number;
}

export interface PlacedLabel {
  x: number;
  anchor: SvgTextAnchor;
  text: string;
  width: number;
  /** The painted extent after clamping — what a collision check compares. */
  start: number;
  end: number;
}

/**
 * Place one label inside [left, right] — the #1573 fix, as arithmetic.
 *
 * Order of operations, and why:
 *   1. ELIDE to the plot's full width first. A label wider than the whole plot
 *      cannot be rescued by anchoring, and clipping it mid-word (a clip-path
 *      alone, the half-measure #1573 warns about) silently lies about the value.
 *   2. FLIP THE ANCHOR at an edge so the text paints INWARD: a mark in the right
 *      margin gets `end`, one in the left margin gets `start`. This is the cheap
 *      fix that keeps the label attached to its mark.
 *   3. SHIFT as a last resort, when even the flipped anchor overflows (a wide
 *      label on a mark near the middle-ish edge). The label detaches from its
 *      mark by a few units, which is strictly better than leaving the plot.
 *
 * Null when the plot is too narrow for any legible remainder.
 */
export function clampLabel({
  x,
  text,
  fontSize,
  anchor = "middle",
  left,
  right,
}: LabelClampInput): PlacedLabel | null {
  const budget = right - left;
  if (!(budget > 0)) return null;
  const fitted = elideToWidth(text, budget, fontSize);
  if (fitted == null) return null;
  const width = textWidth(fitted, fontSize);

  let chosen = anchor;
  let extent = textExtent(x, width, chosen);
  if (extent.right > right) {
    chosen = "end";
    extent = textExtent(x, width, chosen);
  } else if (extent.left < left) {
    chosen = "start";
    extent = textExtent(x, width, chosen);
  }

  let placedX = x;
  if (extent.right > right) {
    placedX -= extent.right - right;
    extent = textExtent(placedX, width, chosen);
  }
  if (extent.left < left) {
    placedX += left - extent.left;
    extent = textExtent(placedX, width, chosen);
  }

  return {
    x: placedX,
    anchor: chosen,
    text: fitted,
    width,
    start: extent.left,
    end: extent.right,
  };
}

export interface RowLabelInput extends Omit<LabelClampInput, "left" | "right"> {
  key: string;
  /**
   * Higher wins a collision. Same priority falls back to left-to-right, so the
   * outcome never depends on input order.
   */
  priority?: number;
}

/**
 * Lay out a ROW of labels that share one baseline, dropping the ones that would
 * overlap — the other half of #1573 ("several same-window labels stack into an
 * unreadable smear").
 *
 * Dropping, not shrinking: shrinking would walk back under the size floor #1518
 * exists to hold, and two half-legible labels answer no question. The survivors
 * are the higher-priority ones (a session's own bed time beats a neighbouring
 * block's wake time), which is why the caller ranks rather than ordering.
 */
export function placeRowLabels(
  items: readonly RowLabelInput[],
  { left, right, minGap = 0 }: { left: number; right: number; minGap?: number }
): Map<string, PlacedLabel> {
  const ranked = items
    .map((item, index) => ({ item, index }))
    .sort(
      (a, b) =>
        (b.item.priority ?? 0) - (a.item.priority ?? 0) ||
        a.item.x - b.item.x ||
        a.index - b.index
    );
  const kept: PlacedLabel[] = [];
  const out = new Map<string, PlacedLabel>();
  for (const { item } of ranked) {
    const placed = clampLabel({ ...item, left, right });
    if (!placed) continue;
    const collides = kept.some(
      (other) =>
        placed.start < other.end + minGap && other.start < placed.end + minGap
    );
    if (collides) continue;
    kept.push(placed);
    out.set(item.key, placed);
  }
  return out;
}

// ── 3. The guard's arithmetic (issue #1518) ──────────────────────────────────

export interface ScaledFontOffender {
  /** 1-based line number in the scanned source. */
  line: number;
  fontSize: number;
  effectivePx: number;
}

/** `fontSize={9}` / `fontSize: 9` / `fontSize={7.5}` — the literal, captured. */
const NUMERIC_FONT_SIZE =
  /(?<![\w-])fontSize\s*(?:=\s*\{|:)\s*([0-9]+(?:\.[0-9]+)?)/g;

/**
 * Every numeric `fontSize` literal in `source` that paints below `minPx` once the
 * panel's viewBox is scaled into its narrowest container.
 *
 * This replaces the blanket exemption `micro-text-size.test.ts` used to grant
 * hand-drawn viewBox panels. The premise of that exemption was right — a raw 7 is
 * not 7px — but the conclusion (guard nothing) removed the floor from exactly the
 * charts whose type size is hardest to reason about. The ratio is the whole
 * difference, and the ratio is computable.
 *
 * A file with no numeric font size yields no offenders (it is not an error to
 * take type size from `viewBoxFontSize()` — that is the preferred shape).
 */
export function scanScaledFontSizes(
  source: string,
  scale: ViewBoxScale,
  minPx: number = MIN_LABEL_PX
): ScaledFontOffender[] {
  const out: ScaledFontOffender[] = [];
  source.split("\n").forEach((text, index) => {
    for (const match of text.matchAll(NUMERIC_FONT_SIZE)) {
      const fontSize = Number(match[1]);
      const effectivePx = effectiveFontPx(fontSize, scale);
      if (effectivePx + 1e-9 < minPx) {
        out.push({ line: index + 1, fontSize, effectivePx });
      }
    }
  });
  return out;
}

/** Whether `source` declares a numeric `fontSize` anywhere — the staleness probe
 *  for a registered panel that has moved all of its sizes into a computed value. */
export function hasNumericFontSize(source: string): boolean {
  NUMERIC_FONT_SIZE.lastIndex = 0;
  const found = NUMERIC_FONT_SIZE.test(source);
  NUMERIC_FONT_SIZE.lastIndex = 0;
  return found;
}
