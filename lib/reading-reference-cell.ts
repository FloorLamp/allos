// WHAT THE "REFERENCE" CELL ON A READING ROW SAYS (#2315).
//
// THE DEFECT. A biomarker row printed `reference_range` — the free-text string the
// lab document stated — beside a flag that was never derived from it.
// `reconciledFlag` judges against the CANONICAL reference range and then the
// CANONICAL optimal band; the printed string reaches that function exactly once, as
// an input to the #761 unit-mislabel detector. It is PROVENANCE, not a threshold. So
// the row showed the one range that never judges it and hid both ranges that do —
// measured at 10.5% of a real profile's readings visibly contradicting their own
// row, including a red "High" on a value sitting comfortably inside the printed
// range.
//
// THE FIX is a cell that states the band(s) the flag actually came from, resolved
// through `metricJudgment` — the documented single lookup (#1996) — and never
// re-derived here. This module owns only the SPELLING of that answer; the bands
// themselves are whatever the judgement says, and the digits are `formatBand`, the
// one band formatter the metric card shares (#221).
//
// The lab's own string does not disappear: it becomes the cell's hover title (and
// stays in full on the reading detail page, under its own "Lab reference" column).
// It moves from assertion to provenance, which is what it always was.
//
// AND THE BAND LABEL IS THE SAFETY HALF. When the applied band is age-curated, the
// cell names it (`ref 80–150 · age 1–3`). A pediatric profile's row printing the
// LAB's adult range while the app flags against the pediatric band is the #150
// failure re-opened on the list surface; naming the band that actually applied is
// what closes it. That is why this cell cannot be a bare number pair.
//
// PURE: no DB. The caller resolves the judgement (lib/queries/metric-judgment.ts).

import { formatBand } from "./band-format";
import type { MetricJudgment } from "./metric-judgment";
import { sameUnit } from "./unit-conversions";

export interface ReferenceCell {
  /**
   * "Reference" when the app's own bands answered — the ranges the flag came
   * from. "Lab reference" when nothing canonical covers this analyte, so the
   * printed string genuinely IS the deciding range and says so.
   */
  label: "Reference" | "Lab reference";
  /** The one-line cell text, or null when there is nothing at all to show. */
  text: string | null;
  /** Hover provenance: what the source document actually printed. */
  title: string | null;
  /** True when the bands shown are the ones the row's flag was derived from. */
  judged: boolean;
}

export interface ReferenceCellInput {
  /** The resolved judgement for this reading's identity + subject, or null. */
  judgment: MetricJudgment | null;
  /** The reading's stored free-text `reference_range`. */
  printed: string | null | undefined;
  /** The reading's own stated unit, for the disagreement check below. */
  unit: string | null | undefined;
}

/**
 * The Reference cell for one reading row.
 *
 * Both bands are shown when both exist (`ref ≤ 90 · optimal ≤ 60`), because
 * "which band did I cross" is exactly what the amber/red split means: a reader
 * given only `optimal ≤ 60` loses the fact that they are inside the reference.
 */
export function referenceCell(input: ReferenceCellInput): ReferenceCell {
  const printed = input.printed?.trim() || null;
  const j = input.judgment;
  if (j) {
    // The unit rides along ONLY when the row's own stated unit disagrees with the
    // canonical one the band is expressed in. In the ordinary case the value cell
    // an inch to the left already carries the unit and repeating it just costs
    // width; in the divergent case (a reading in mg/L judged by a mg/dL band) a
    // bare number pair would be a second silent mismatch of exactly the kind this
    // issue exists to end. `sameUnit` treats an absent unit on either side as
    // agreement — nothing is claimed when nothing was stated.
    const suffix = j.unit && !sameUnit(input.unit, j.unit) ? ` ${j.unit}` : "";
    const ref = formatBand(j.low, j.high, suffix);
    const optimal = formatBand(j.optimalLow, j.optimalHigh, suffix);
    const parts: string[] = [];
    if (ref) parts.push(`ref ${ref}`);
    if (optimal) parts.push(`optimal ${optimal}`);
    // The age band that ACTUALLY applied, when one did (#150).
    if (j.bandLabel) parts.push(j.bandLabel);
    if (parts.length > 0) {
      return {
        label: "Reference",
        text: parts.join(" · "),
        title: printed ? `Lab reference: ${printed}` : null,
        judged: true,
      };
    }
  }
  // No canonical entry (or an entry with no numeric band): the printed string IS
  // the deciding range here, so it shows exactly as before — relabelled, so the
  // reader can tell the two cases apart.
  return { label: "Lab reference", text: printed, title: null, judged: false };
}
