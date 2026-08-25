/** Universal effective target floor, in CSS pixels. */
export const TAP_FLOOR_PX = 44;

/** Tolerance for browser subpixel noise in rendered geometry checks. */
export const TAP_FLOOR_FLOAT_EPSILON_PX = 0.01;

/** Per-side extension owned by `.tap-target` on coarse pointers. */
export const TAP_TARGET_INSET_PX = 6;

/** Smallest rendered box that `.tap-target` can extend to the floor. */
export const TAP_TARGET_MIN_RENDERED_PX =
  TAP_FLOOR_PX - 2 * TAP_TARGET_INSET_PX;
