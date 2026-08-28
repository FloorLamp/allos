/**
 * THE CONTROL BOX, in CSS pixels — one rendered height for every control kind at
 * every viewport (owner ruling, #3938). The stylesheet spends it as
 * `--control-box` in app/globals.css (SECTION: Touch tap targets); this is the
 * same number for the browser proofs, which read RENDERED boxes.
 */
export const CONTROL_BOX_PX = 34;

/** Universal effective target floor, in CSS pixels. */
export const TAP_FLOOR_PX = 44;

/** Tolerance for browser subpixel noise in rendered geometry checks. */
export const TAP_FLOOR_FLOAT_EPSILON_PX = 0.01;

/** Per-side extension a coarse pointer gets around a control (`--control-reach`). */
export const TAP_TARGET_INSET_PX = 6;

/**
 * The gap two adjacent targets keep so their extended hit regions meet without
 * ever owning the same point: each reaches `TAP_TARGET_INSET_PX` toward the other.
 */
export const CONTROL_GAP_FLOOR_PX = 2 * TAP_TARGET_INSET_PX;

/** Smallest rendered box that the reach can extend to the floor. */
export const TAP_TARGET_MIN_RENDERED_PX =
  TAP_FLOOR_PX - 2 * TAP_TARGET_INSET_PX;
