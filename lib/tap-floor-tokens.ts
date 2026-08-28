/**
 * THE CONTROL BOX — one rendered height for every control kind at every viewport
 * (owner ruling #3938), spent as `--control-box` in app/globals.css.
 */
export const CONTROL_BOX_PX = 34;

/** Universal effective target floor, in CSS pixels. */
export const TAP_FLOOR_PX = 44;

/** Tolerance for browser subpixel noise in rendered geometry checks. */
export const TAP_FLOOR_FLOAT_EPSILON_PX = 0.01;

/** Per-side extension a coarse pointer gets around a control (`--control-reach`). */
export const TAP_TARGET_INSET_PX = 6;

/** Smallest rendered box that the reach can extend to the floor. */
export const TAP_TARGET_MIN_RENDERED_PX =
  TAP_FLOOR_PX - 2 * TAP_TARGET_INSET_PX;
