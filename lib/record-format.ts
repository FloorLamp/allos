import {
  DOCUMENT_SOURCE_PREFIX,
  documentSourceId,
} from "@/lib/document-source";
import {
  DEFAULT_FORMAT_PREFS,
  formatClock,
  formatDateShape,
  type DisplayFormatPrefs,
} from "@/lib/format-date";

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

// Resolve the source document behind any record-shaped row. Most clinical tables
// carry a dedicated `document_id`; older/source-keyed stores (notably
// immunizations) encode the same identity as `source = 'document:<id>'`. UI
// callers should never have to know which storage shape a domain uses.
export function sourceDocumentId(
  documentId: number | null | undefined,
  source: string | null | undefined
): number | null {
  if (Number.isInteger(documentId) && Number(documentId) > 0)
    return Number(documentId);
  return source ? documentSourceId(source) : null;
}

// Format a plain YYYY-MM-DD date as "Mon D, YYYY" (UTC-safe, so no off-by-one from
// the viewer's timezone). Returns `fallback` for a null/empty date, and falls back
// to the raw string if it isn't a plain ISO date. Pref-aware (#964): `prefs`
// reorders the date to the login's chosen shape; the DEFAULT reproduces the old
// "Jan 5, 2026" output byte-for-byte AND is deterministic — this is where the old
// implicit-locale toLocaleDateString call (the #964 server-locale leak) lived.
export function formatRecordDate(
  date: string | null,
  fallback = "—",
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
): string {
  if (!date) return fallback;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) return date;
  return formatDateShape(prefs.dateFormat, +m[1], +m[2], +m[3], {
    monthStyle: "short",
    year: true,
  });
}

// Format a stored datetime ("YYYY-MM-DD HH:MM", the shape appointments store in
// `scheduled_at`) as "Mon D, YYYY, <clock>". The wall-clock digits render exactly
// as stored (no viewer-timezone shift). Falls back to formatRecordDate for a plain
// date, and to `fallback` for null/empty. Pref-aware (#964): the date follows the
// login's shape and the time the login's 12h/24h clock; the DEFAULT (24h, the
// dominant clock) renders "Jan 5, 2026, 16:02". This replaces the old
// implicit-locale toLocaleString call that leaked the server locale for BOTH the
// date shape and the (formerly always-12h) clock.
export function formatRecordDateTime(
  value: string | null,
  fallback = "—",
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
): string {
  if (!value) return fallback;
  const m = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})/.exec(value);
  if (!m) return formatRecordDate(value, fallback, prefs);
  const datePart = formatDateShape(prefs.dateFormat, +m[1], +m[2], +m[3], {
    monthStyle: "short",
    year: true,
  });
  const timePart = formatClock(prefs.timeFormat, +m[4], +m[5], "upper-space");
  return `${datePart}, ${timePart}`;
}

// A visit, reduced to the three things that identify it in prose. Structurally the
// LinkedEncounterRef the visit-link query layer returns (lib/queries/visit-links),
// restated here so this pure module has no import into the DB layer.
export interface VisitLabelRef {
  date: string;
  type: string | null;
  providerName: string | null;
}

// ONE computation for "which visit is this?" (#1526). Every surface that names a
// linked visit renders it identically — the per-row "Recorded at / Checked at:"
// sub-line (RecordEncounterLink), and the encounter picker's <option> text on the
// allergy and skin-lesion forms. Without a single formatter the picker and the
// resulting sub-line would drift, and the user would pick "Dermatology · Mar 3" then
// read back something else. The type leads (it is what the user calls the visit),
// the provider is context, the date disambiguates two visits of the same kind.
// Falls back to a generic "Visit" when the row carries no type, so an option is
// never blank.
export function formatVisitLabel(
  visit: VisitLabelRef,
  prefs: DisplayFormatPrefs = DEFAULT_FORMAT_PREFS
): string {
  return [
    visit.type?.trim() || "Visit",
    visit.providerName?.trim() || null,
    formatRecordDate(visit.date, "", prefs) || null,
  ]
    .filter(Boolean)
    .join(" · ");
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

// ---- Immunization administration details (#1406) ----------------------------

// Human labels for the CHECK-pinned route vocabulary.
const ROUTE_LABELS: Record<string, string> = {
  intramuscular: "IM",
  subcutaneous: "SC",
  intradermal: "ID",
  oral: "PO",
  intranasal: "IN",
  other: "Other route",
};

// The one-line "lot / route / site" summary of HOW a dose was given (#1406) — the
// facts school / travel / camp / employer forms ask for. ONE computation, so the
// history table, the per-vaccine dose list, and the export can never phrase the same
// dose differently. Absent parts are simply omitted; an entirely unstated dose
// returns "" (the caller renders its own em dash), because unstated is a real
// answer and must not be printed as a guess.
export function immunizationAdministrationLine(dose: {
  lot_number: string | null;
  route: string | null;
  site: string | null;
}): string {
  const parts: string[] = [];
  if (dose.lot_number?.trim()) parts.push(`Lot ${dose.lot_number.trim()}`);
  if (dose.route) parts.push(ROUTE_LABELS[dose.route] ?? dose.route);
  if (dose.site?.trim()) parts.push(dose.site.trim());
  return parts.join(" · ");
}
