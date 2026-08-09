// WHAT A FLAGGED VALUE SAYS BESIDE ITSELF (#1220/#2315).
//
// `MedicalValue` renders a reading as "value unit" plus a caret and a color. The
// caret's DIRECTION is a shape, so it survives color blindness; the red-vs-amber
// SEVERITY — "High" versus "Above optimal" — did not. #1220 named that gap exactly
// and then closed it on ONE surface, the dashboard's Recent-labs widget, by adding a
// second, parallel visible label beside the component. The biomarkers table, where
// out-of-range and above-optimal readings sit intermixed in a single list, still
// distinguished them by color alone for a sighted reader.
//
// So the label becomes a mode of the component instead of a thing built next to it,
// and this module is the decision: given a flag and whether the surface wants the
// label visible, WHAT text renders and HOW. Two rules it exists to keep:
//
//   • VISIBLE INSTEAD OF sr-only, never both — a screen reader must announce the
//     severity once, not twice.
//   • Without the opt-in, the answer is byte-identical to the pre-#2315 behavior:
//     an sr-only label on the directional flags only. Every call site that has not
//     been considered against its own density keeps exactly what it had.
//
// PURE: no React. `components/ui.tsx` renders this; `lib/__tests__/medical-value.test.ts`
// proves both rules without needing a DOM.

import { flagLabel, isNormalFlag } from "./reference-range";

/** Which way the caret points, or null when the flag states no direction. */
export type MedicalValueCaret = "up" | "down" | null;

/**
 * Clinical high / above-optimal point up; low / below-optimal point down. The
 * legacy directionless "non-optimal" gets no caret (it re-derives to a directional
 * flag on the next reconcile), and neither does a qualitative "abnormal" — there is
 * no direction to claim.
 */
export function medicalValueCaret(
  flag: string | null | undefined
): MedicalValueCaret {
  if (flag === "high" || flag === "non-optimal-high") return "up";
  if (flag === "low" || flag === "non-optimal-low") return "down";
  return null;
}

export interface MedicalFlagText {
  /** The one shared label (lib/reference-range flagLabel — the #306 chokepoint). */
  label: string;
  /** True → render it as text; false → render it in an `sr-only` span. */
  visible: boolean;
}

/**
 * The flag text a value renders, or null when it renders none.
 *
 * `showFlagLabel` widens the set as well as the presentation: the sr-only label
 * only ever accompanied a caret, so a directionless non-normal flag ("Abnormal",
 * "Immune", legacy "Non-optimal") had no text channel at all. A surface that opts
 * in wants the severity word for every flag it colors, which is exactly the set
 * `isNormalFlag` excludes.
 */
export function medicalValueFlagText(
  flag: string | null | undefined,
  showFlagLabel = false
): MedicalFlagText | null {
  if (showFlagLabel) {
    return isNormalFlag(flag)
      ? null
      : { label: flagLabel(flag), visible: true };
  }
  return medicalValueCaret(flag)
    ? { label: flagLabel(flag), visible: false }
    : null;
}
