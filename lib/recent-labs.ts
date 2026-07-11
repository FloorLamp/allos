import type { MedicalCategory, MedicalFlag, MedicalRecord } from "./types";

// Which medical-record categories count as "labs" for the recent-labs surfaces:
// numeric lab panels and canonical biomarkers, not vitals/scans/prescriptions.
export const LAB_CATEGORIES: ReadonlySet<MedicalCategory> =
  new Set<MedicalCategory>(["lab", "biomarker"]);

// One latest lab/biomarker reading, flattened for display by a surface.
export interface RecentLabRow {
  name: string;
  value: string | null;
  unit: string | null;
  flag: MedicalFlag | null;
  date: string;
  href: string;
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
  return records
    .filter((r) => LAB_CATEGORIES.has(r.category))
    .slice()
    .sort((a, b) => {
      const af = a.flag && a.flag !== "normal" ? 0 : 1;
      const bf = b.flag && b.flag !== "normal" ? 0 : 1;
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
        href: r.canonical_name?.trim()
          ? `/biomarkers/view?name=${encodeURIComponent(name)}`
          : "/biomarkers",
      };
    });
}
