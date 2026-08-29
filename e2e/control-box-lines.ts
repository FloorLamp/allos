/**
 * Round the measured control-box growth without leaking JavaScript's `-0`.
 *
 * Chromium can report a box a tiny fraction below its CSS size. `Math.round`
 * preserves that value's negative sign, while the surrounding tolerance treats
 * it as the zero-line box. Normalize only that representation; real negative
 * and positive line counts stay unchanged for the caller's invariant checks.
 */
export function roundControlBoxExtraLines(extra: number): number {
  const rounded = Math.round(extra);
  return Object.is(rounded, -0) ? 0 : rounded;
}
