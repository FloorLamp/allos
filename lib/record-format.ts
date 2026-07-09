import { DOCUMENT_SOURCE_PREFIX } from "@/lib/body-metric-extract";

// Shared presentation helpers for the clinical/medical list pages (conditions,
// procedures, allergies, family-history, care-plan, care-goals, encounters,
// immunizations). These are pure formatters — no DB, no React — so they're unit
// tested in lib/__tests__/record-format.test.ts and reused wherever a clinical
// row renders a provenance label, a date, or a title-cased enum value.

// Provenance label for a clinical row's `source` column. Doc-sourced rows carry
// `document:<id>` (the shared DOCUMENT_SOURCE_PREFIX) and read as "Document";
// a null source is a manually entered row; any other value (e.g. an integration
// id) is shown verbatim.
export function sourceLabel(source: string | null): string {
  if (!source) return "Manual";
  if (source.startsWith(DOCUMENT_SOURCE_PREFIX)) return "Document";
  return source;
}

// Format a plain YYYY-MM-DD date as "Mon D, YYYY" (UTC-safe, so no off-by-one
// from the viewer's timezone). Returns `fallback` for a null/empty date, and
// falls back to the raw string if it isn't a plain ISO date.
export function formatRecordDate(date: string | null, fallback = "—"): string {
  if (!date) return fallback;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return dt.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    timeZone: "UTC",
  });
}

// Capitalize the first character of a lowercase enum value (e.g. a status or
// category) for display. Leaves the rest untouched.
export function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
