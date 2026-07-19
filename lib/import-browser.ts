// Pure logic for the import-detail TABBED records browser (issue #271).
//
// The /import/[id] page replaces the old "What it produced" summary card + the
// single medical_records table with one tab strip: a tab per non-empty produced
// type, built from the SAME DocumentProducedCounts the summary used (so the tab
// counts and extracted_count share one source, #212). Each tab knows its domain,
// so rows link category-correctly — the fix for prescription rows landing on
// biomarker pages. Everything here is pure (no DB/network) and unit-tested in
// lib/__tests__/import-browser.test.ts; the per-tab DB reads live in
// lib/queries/imports.ts and the page maps their rows through the shapers below.

import type { DocumentProducedCounts } from "./import-log";
import type { WeightUnit } from "./settings";
import { fmtWeight } from "./units";
import {
  biomarkerViewHref,
  encounterHref,
  MEDICATIONS_HREF,
  type AppRoute,
} from "./hrefs";
import {
  variantDisplayLabel,
  resultTypeLabel,
  significanceLabel,
} from "./genomic-variant";
import {
  studyDisplayLabel,
  modalityLabel,
  lateralityLabel,
} from "./imaging-study";
import {
  prescriptionDisplayLabel,
  formatDiopter,
} from "./optical-prescription";
import type {
  GenomicResultType,
  GenomicSignificance,
  Zygosity,
  ImagingModality,
  ImagingLaterality,
  OpticalKind,
} from "./types/medical";

// The non-record tab kinds, in display order (after the record-category tabs).
// "records" tabs are data-driven from recordsByCategory. Providers are NOT a tab
// — they're a global registry, not this document's owned rows — so they stay a
// count chip that links to /providers (#275); see ImportTabStrip.providers.
export type ImportTabKind =
  | "records"
  | "visits"
  | "conditions"
  | "allergies"
  | "immunizations"
  | "procedures"
  | "family-history"
  | "care-plan"
  | "care-goals"
  | "genomic-variants"
  | "imaging-studies"
  | "optical-prescriptions"
  | "appointments"
  | "medications"
  | "body";

export interface ImportTab {
  // The ?tab= SearchParam value; unique within a strip.
  key: string;
  label: string;
  count: number;
  kind: ImportTabKind;
  // The medical_records category a "records" tab scopes to.
  category?: string;
}

export interface ImportTabStrip {
  tabs: ImportTab[];
  // Distinct providers this document's rows reference (global registry). A count
  // chip (linking to /providers, #275), not a tab, since providers aren't this
  // document's owned rows. Excluded from extracted_count by design.
  providers: number;
}

// Display label for a medical_records category (mirrors the category vocabulary
// of the biomarkers filter; an unknown category falls back to its raw name).
export function recordCategoryLabel(category: string): string {
  switch (category) {
    case "lab":
      return "Labs";
    case "biomarker":
      return "Biomarkers";
    case "genomics":
      return "Genomics";
    case "vitals":
      return "Vitals";
    case "scan":
      return "Imaging / scans";
    case "prescription":
      return "Prescriptions";
    default:
      return category;
  }
}

// Canonical display order for record-category tabs (matching the category
// filter's option order); unknown categories sort after, alphabetically.
const CATEGORY_ORDER = [
  "vitals",
  "lab",
  "genomics",
  "biomarker",
  "scan",
  "prescription",
];

function categoryRank(category: string): number {
  const i = CATEGORY_ORDER.indexOf(category);
  return i === -1 ? CATEGORY_ORDER.length : i;
}

// Reserved non-record tab keys; a records tab whose category collided with one
// (impossible under the current category CHECK, but categories are data) gets a
// "records:" prefix so keys stay unique.
const DOMAIN_TAB_KEYS = new Set<string>([
  "visits",
  "conditions",
  "allergies",
  "immunizations",
  "procedures",
  "family-history",
  "care-plan",
  "care-goals",
  "genomic-variants",
  "imaging-studies",
  "optical-prescriptions",
  "appointments",
  "medications",
  "body",
]);

// Build the tab strip from the produced counts: one tab per NON-EMPTY produced
// type — record categories first (in canonical category order), then the
// clinical/domain kinds — plus the provider chip count. Zero-count types get no
// tab, so the strip is exactly "what this import produced".
export function buildImportTabs(
  counts: DocumentProducedCounts
): ImportTabStrip {
  const tabs: ImportTab[] = [];
  const cats = [...counts.recordsByCategory]
    .filter((r) => r.count > 0)
    .sort(
      (a, b) =>
        categoryRank(a.category) - categoryRank(b.category) ||
        a.category.localeCompare(b.category)
    );
  for (const r of cats) {
    tabs.push({
      key: DOMAIN_TAB_KEYS.has(r.category)
        ? `records:${r.category}`
        : r.category,
      label: recordCategoryLabel(r.category),
      count: r.count,
      kind: "records",
      category: r.category,
    });
  }
  const add = (key: string, label: string, count: number) => {
    if (count > 0) tabs.push({ key, label, count, kind: key as ImportTabKind });
  };
  add("visits", "Visits", counts.encounters);
  add("conditions", "Conditions", counts.conditions);
  add("allergies", "Allergies", counts.allergies);
  add("immunizations", "Immunizations", counts.immunizations);
  add("procedures", "Procedures", counts.procedures);
  add("family-history", "Family history", counts.familyHistory);
  add("care-plan", "Care plan", counts.carePlanItems);
  add("care-goals", "Care goals", counts.careGoals);
  add("genomic-variants", "Genomic variants", counts.genomicVariants);
  add("imaging-studies", "Imaging studies", counts.imagingStudies);
  add(
    "optical-prescriptions",
    "Optical prescriptions",
    counts.opticalPrescriptions
  );
  add("appointments", "Appointments", counts.appointments);
  add("medications", "Medications", counts.medications);
  add(
    "body",
    "Body metrics",
    counts.bodyMetrics + counts.heightSamples + counts.headCircSamples
  );
  return { tabs, providers: counts.providers };
}

// Resolve the ?tab= SearchParam against the built strip: an exact key match
// wins, anything else (absent/stale/unknown) falls back to the FIRST tab.
// Returns undefined only for an empty strip (an import that produced nothing).
export function resolveImportTab(
  tabs: ImportTab[],
  param: string | undefined
): ImportTab | undefined {
  return tabs.find((t) => t.key === param) ?? tabs[0];
}

// ---- Category-correct record links ----

// Where a medical_records row's NAME should link, by category. Series-style
// categories (labs/vitals/biomarkers/genomics) go to the biomarker series view
// for their canonical name; prescriptions go to the medications page (the
// prescription→biomarker bug this fixes); scans/notes/unknown categories get NO
// link rather than a wrong one.
export function recordNameLink(
  category: string,
  canonicalName: string | null | undefined
): { href: AppRoute; title: string } | null {
  switch (category) {
    case "lab":
    case "biomarker":
    case "vitals":
    case "genomics": {
      const name = canonicalName?.trim();
      if (!name) return null;
      return {
        href: biomarkerViewHref(name),
        title: `View ${name} over time`,
      };
    }
    case "prescription":
      return { href: MEDICATIONS_HREF, title: "View medications" };
    default:
      return null;
  }
}

// ---- Read-only per-tab row items ----

// The normalized display row a non-record tab renders: main text, a muted
// detail line, an optional date, and the domain deep link.
export interface ProducedItem {
  id: number;
  title: string;
  detail: string | null;
  date: string | null;
  href: AppRoute;
}

// Join non-empty fragments into one muted detail line.
function detailLine(...parts: (string | null | undefined)[]): string | null {
  const kept = parts.map((p) => p?.trim()).filter(Boolean) as string[];
  return kept.length > 0 ? kept.join(" · ") : null;
}

export function visitItem(row: {
  id: number;
  date: string;
  end_date: string | null;
  type: string | null;
  reason: string | null;
}): ProducedItem {
  return {
    id: row.id,
    title: row.type?.trim() || "Visit",
    detail: detailLine(row.reason),
    date: row.end_date ? `${row.date} – ${row.end_date}` : row.date,
    href: encounterHref(row.id),
  };
}

export function conditionItem(row: {
  id: number;
  name: string;
  status: string;
  onset_date: string | null;
  code: string | null;
}): ProducedItem {
  return {
    id: row.id,
    title: row.name,
    detail: detailLine(row.status, row.code),
    date: row.onset_date,
    href: "/conditions",
  };
}

export function allergyItem(row: {
  id: number;
  substance: string;
  reaction: string | null;
  severity: string | null;
  status: string;
}): ProducedItem {
  return {
    id: row.id,
    title: row.substance,
    detail: detailLine(row.reaction, row.severity, row.status),
    date: null,
    href: "/allergies",
  };
}

export function immunizationItem(row: {
  id: number;
  date: string;
  vaccine: string;
  dose_label: string | null;
}): ProducedItem {
  return {
    id: row.id,
    title: row.vaccine,
    detail: detailLine(row.dose_label),
    date: row.date,
    href: "/immunizations",
  };
}

export function procedureItem(row: {
  id: number;
  name: string;
  code: string | null;
  date: string | null;
}): ProducedItem {
  return {
    id: row.id,
    title: row.name,
    detail: detailLine(row.code),
    date: row.date,
    href: "/procedures",
  };
}

export function familyHistoryItem(row: {
  id: number;
  relation: string | null;
  condition: string;
  onset_age: number | null;
}): ProducedItem {
  return {
    id: row.id,
    title: row.condition,
    detail: detailLine(
      row.relation,
      row.onset_age != null ? `onset age ${row.onset_age}` : null
    ),
    date: null,
    href: "/family-history",
  };
}

export function carePlanItemRow(row: {
  id: number;
  description: string;
  category: string | null;
  planned_date: string | null;
  status: string | null;
}): ProducedItem {
  return {
    id: row.id,
    title: row.description,
    detail: detailLine(row.category, row.status),
    date: row.planned_date,
    href: "/care-plan",
  };
}

export function careGoalItem(row: {
  id: number;
  description: string;
  target_date: string | null;
  status: string | null;
}): ProducedItem {
  return {
    id: row.id,
    title: row.description,
    detail: detailLine(row.status),
    date: row.target_date,
    href: "/care-goals",
  };
}

export function genomicVariantItem(row: {
  id: number;
  gene: string;
  variant: string | null;
  genotype: string | null;
  star_allele: string | null;
  zygosity: Zygosity | null;
  significance: GenomicSignificance | null;
  result_type: GenomicResultType;
  report_date: string | null;
}): ProducedItem {
  return {
    id: row.id,
    title: variantDisplayLabel(row),
    // Factual detail only — the significance term as reported + the routing class.
    // No risk interpretation (see #711 product decision).
    detail: detailLine(
      row.significance ? significanceLabel(row.significance) : null,
      resultTypeLabel(row.result_type)
    ),
    date: row.report_date,
    href: "/genomics",
  };
}

export function imagingStudyItem(row: {
  id: number;
  modality: ImagingModality;
  body_region: string | null;
  laterality: ImagingLaterality | null;
  contrast: number | boolean;
  study_date: string | null;
  impression: string | null;
}): ProducedItem {
  const contrast =
    row.contrast === 1 || row.contrast === true ? "with contrast" : null;
  // A real side (left/right/bilateral) is informative; 'na' (midline/whole study)
  // adds nothing, so it's omitted — same rule the display label uses.
  const side =
    row.laterality && row.laterality !== "na"
      ? lateralityLabel(row.laterality)
      : null;
  return {
    id: row.id,
    title: studyDisplayLabel(row),
    // Factual detail: modality + laterality classification, contrast, then the
    // radiologist's impression (truncated by the UI). No added interpretation.
    detail: detailLine(
      modalityLabel(row.modality),
      side,
      contrast,
      row.impression
    ),
    date: row.study_date,
    href: "/imaging",
  };
}

export function opticalPrescriptionItem(row: {
  id: number;
  kind: OpticalKind;
  od_sphere: number | null;
  os_sphere: number | null;
  pd: number | null;
  issued_date: string | null;
}): ProducedItem {
  return {
    id: row.id,
    title: prescriptionDisplayLabel(row),
    // Factual detail: the per-eye sphere line + PD when present. No interpretation.
    detail: detailLine(
      row.od_sphere != null ? `OD ${formatDiopter(row.od_sphere)}` : null,
      row.os_sphere != null ? `OS ${formatDiopter(row.os_sphere)}` : null,
      row.pd != null ? `PD ${row.pd}` : null
    ),
    date: row.issued_date,
    href: "/vision",
  };
}

export function appointmentItem(row: {
  id: number;
  scheduled_at: string;
  title: string | null;
  location: string | null;
  status: string;
}): ProducedItem {
  return {
    id: row.id,
    title: row.title ?? "Appointment",
    detail: detailLine(row.location ?? row.status),
    // The scheduled date (drop any time portion for the listing's date column).
    date: row.scheduled_at.slice(0, 10),
    href: "/encounters",
  };
}

export function medicationItem(row: {
  id: number;
  name: string;
  kind: string;
}): ProducedItem {
  return {
    id: row.id,
    title: row.name,
    detail: detailLine(row.kind),
    date: null,
    href: MEDICATIONS_HREF,
  };
}

// The merged Body-metrics tab: one item per body_metrics row (weight/body fat/
// resting HR, weight rendered in the login's display unit) plus one per height
// and head-circumference sample, newest-first. Ids can collide across the three
// source tables, so items get a per-source key prefix upstream of React via the
// deterministic ordering here; the listing keys on (href, index).
export function bodyItems(
  rows: {
    bodyMetrics: {
      id: number;
      date: string;
      weight_kg: number | null;
      body_fat_pct: number | null;
      resting_hr: number | null;
    }[];
    heights: { id: number; date: string; value: number }[];
    headCircs: { id: number; date: string; value: number }[];
  },
  weightUnit: WeightUnit
): ProducedItem[] {
  const items: ProducedItem[] = [];
  for (const b of rows.bodyMetrics) {
    items.push({
      id: b.id,
      title: "Body metrics",
      detail: detailLine(
        b.weight_kg != null
          ? `Weight ${fmtWeight(b.weight_kg, weightUnit)}`
          : null,
        b.body_fat_pct != null ? `Body fat ${b.body_fat_pct}%` : null,
        b.resting_hr != null ? `Resting HR ${b.resting_hr} bpm` : null
      ),
      date: b.date,
      href: "/trends?tab=body",
    });
  }
  for (const h of rows.heights) {
    items.push({
      id: h.id,
      title: "Height",
      detail: `${h.value} cm`,
      date: h.date,
      href: "/trends?tab=body",
    });
  }
  for (const h of rows.headCircs) {
    items.push({
      id: h.id,
      title: "Head circumference",
      detail: `${h.value} cm`,
      date: h.date,
      href: "/trends?tab=body",
    });
  }
  return items.sort((a, b) =>
    a.date && b.date ? b.date.localeCompare(a.date) : 0
  );
}
