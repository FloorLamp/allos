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

// Format a stored datetime ("YYYY-MM-DD HH:MM", the shape appointments store in
// `scheduled_at`) as "Mon D, YYYY, H:MM AM/PM". UTC-safe like formatRecordDate so
// the wall-clock digits render exactly as stored (no viewer-timezone shift). Falls
// back to formatRecordDate for a plain date, and to `fallback` for null/empty.
export function formatRecordDateTime(
  value: string | null,
  fallback = "—"
): string {
  if (!value) return fallback;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(value);
  if (!m) return formatRecordDate(value, fallback);
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]));
  return dt.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZone: "UTC",
  });
}

// Capitalize the first character of a lowercase enum value (e.g. a status or
// category) for display. Leaves the rest untouched.
export function titleCase(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

// Semantic tone (Tailwind pill classes) for a clinical status value, so the same
// status looks the same across the conditions/allergies/care-plan/care-goals
// lists (#643). Keyed by the lowercased status; unknown values fall back to a
// neutral slate tone. This is the single source the shared StatusBadge formats
// over — "one presentation, many surfaces".
const STATUS_TONE_AMBER =
  "bg-amber-100 text-amber-700 dark:bg-amber-950 dark:text-amber-300";
const STATUS_TONE_EMERALD =
  "bg-emerald-100 text-emerald-700 dark:bg-emerald-950 dark:text-emerald-300";
const STATUS_TONE_SKY =
  "bg-sky-100 text-sky-700 dark:bg-sky-950 dark:text-sky-300";
const STATUS_TONE_SLATE =
  "bg-slate-100 text-slate-600 dark:bg-ink-800 dark:text-slate-300";

const STATUS_TONES: Record<string, string> = {
  // Ongoing / open
  active: STATUS_TONE_AMBER,
  ongoing: STATUS_TONE_AMBER,
  "in progress": STATUS_TONE_AMBER,
  // Positive / closed-good
  resolved: STATUS_TONE_EMERALD,
  achieved: STATUS_TONE_EMERALD,
  completed: STATUS_TONE_EMERALD,
  complete: STATUS_TONE_EMERALD,
  done: STATUS_TONE_EMERALD,
  met: STATUS_TONE_EMERALD,
  // Future / intended
  proposed: STATUS_TONE_SKY,
  planned: STATUS_TONE_SKY,
  pending: STATUS_TONE_SKY,
  scheduled: STATUS_TONE_SKY,
  // Neutral / closed-neutral
  inactive: STATUS_TONE_SLATE,
  archived: STATUS_TONE_SLATE,
  cancelled: STATUS_TONE_SLATE,
  canceled: STATUS_TONE_SLATE,
  "on hold": STATUS_TONE_SLATE,
  "not started": STATUS_TONE_SLATE,
};

export function statusTone(status: string): string {
  return STATUS_TONES[status.trim().toLowerCase()] ?? STATUS_TONE_SLATE;
}
