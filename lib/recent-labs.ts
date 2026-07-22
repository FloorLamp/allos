import {
  flagLabel,
  flagTone,
  isNonOptimal,
  isOutOfRange,
  type FlagTone,
} from "./reference-range";
import type { MedicalCategory, MedicalFlag, MedicalRecord } from "./types";
import { biomarkerViewHref, type AppRoute } from "./hrefs";

// Which medical-record categories count as "labs" for the recent-labs surfaces:
// `lab` ONLY (#1076). Vitals, screening instruments, derived composites, and
// immutable facts each have their own home and must not appear in a recent-labs
// list; the legacy `biomarker` bucket is emptied of real labs (Glucose is now `lab`).
export const LAB_CATEGORIES: ReadonlySet<MedicalCategory> =
  new Set<MedicalCategory>(["lab"]);

// One latest lab/biomarker reading, flattened for display by a surface.
export interface RecentLabRow {
  name: string;
  value: string | null;
  unit: string | null;
  flag: MedicalFlag | null;
  date: string;
  href: AppRoute;
}

// High/low variants carry a directional caret in MedicalValue. These legacy or
// qualitative statuses have no direction, so compact surfaces need an explicit
// text label instead of relying on value color alone.
export function recentLabDirectionlessStatus(
  flag: MedicalFlag | null
): { label: string; tone: FlagTone } | null {
  return flag === "abnormal" || flag === "non-optimal" || flag === "immune"
    ? { label: flagLabel(flag), tone: flagTone(flag) }
    : null;
}

// The subset of a medical record the highlight selection reads. `getMedicalRecords`
// rows satisfy it; tests can build the minimal shape.
type LabRecord = Pick<
  MedicalRecord,
  "category" | "flag" | "date" | "canonical_name" | "name" | "value" | "unit"
>;

// Recent-labs highlight selection (issue #313, extracted from the dashboard).
// Of the current (latest-per-marker) lab/biomarker readings, pick the few to
// surface: out-of-range markers float to the top, then newest-first, then take
// the first `limit`. A flagged marker being the headline is the whole point, so
// the flag precedence leads and the date tie-break is only among equally-flagged
// rows. Pure over the `{ current: true }` medical-records read so a digest,
// weekly recap, or HA "recent labs" read shares the identical policy.
export function recentLabHighlights(
  records: LabRecord[],
  limit = 6
): RecentLabRow[] {
  // "Notable" = the canonical notability predicate (issue #544/#551): out-of-range
  // (high/low/abnormal) OR non-optimal. A loose `flag !== "normal"` test would sort
  // the neutral "immune" flag (a good durable-immunity titer) to the top as if
  // abnormal — exactly the "good result reads as needs-attention" behavior #544
  // eliminates. Route through isOutOfRange/isNonOptimal so a new neutral flag value
  // can't be miscategorized here.
  const notable = (flag: MedicalFlag | null): boolean =>
    isOutOfRange(flag) || isNonOptimal(flag);
  return records
    .filter((r) => LAB_CATEGORIES.has(r.category))
    .slice()
    .sort((a, b) => {
      const af = notable(a.flag) ? 0 : 1;
      const bf = notable(b.flag) ? 0 : 1;
      return af - bf || b.date.localeCompare(a.date);
    })
    .slice(0, limit)
    .map((r) => {
      const name = r.canonical_name?.trim() || r.name;
      return {
        name,
        value: r.value,
        unit: r.unit,
        flag: r.flag,
        date: r.date,
        href: biomarkerViewHref(r.canonical_name, r.name),
      };
    });
}
