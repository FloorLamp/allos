import type { ExtractedImmunization } from "./medical-extract";
import { isRealIsoDate } from "./date";
import { normalizeVaccineName, slugifyVaccine } from "./immunization-catalog";

// Projects vaccine administrations extracted from an uploaded document (a
// vaccine card / immunization record) into `immunizations` rows. Mirrors
// body-metric-extract: rows carry `source = 'document:<id>'` so they are replaced
// on reprocess and removed with the document, and manual rows (source NULL) are
// never touched. Pure and unit-tested — no DB access here. The document-source
// helpers (DOCUMENT_SOURCE_PREFIX / documentSource) live in body-metric-extract;
// import them from there directly.

export interface DocImmunization {
  vaccine: string; // normalized catalog/combo code, or a slug fallback
  date: string; // YYYY-MM-DD
  dose_label: string | null;
  notes: string | null;
}

// Validate calendar-real ISO dates (rejects 2025-13-45 / 2025-02-30), the same
// check the manual write path (immunizations/actions.ts) uses — so extracted and
// hand-entered doses are validated by one rule.
const isoOrNull = (s: string | null | undefined): string | null =>
  isRealIsoDate(s) ? s : null;

const clip = (s: unknown, max: number): string | null => {
  const v = typeof s === "string" ? s.trim() : "";
  return v ? v.slice(0, max) : null;
};

export function immunizationsFromExtraction(
  items: ExtractedImmunization[] | undefined,
  documentDate: string | null
): DocImmunization[] {
  if (!Array.isArray(items)) return [];
  const fallback = isoOrNull(documentDate);
  const out: DocImmunization[] = [];
  for (const it of items) {
    const printed = typeof it?.vaccine === "string" ? it.vaccine.trim() : "";
    if (!printed) continue;
    // A dose with no real date is skipped rather than dated "today" — an
    // invented date would misplace an old shot on the schedule.
    const date = isoOrNull(it?.date) ?? fallback;
    if (!date) continue;
    // Unrecognized names are never dropped: fall back to a slug so the dose
    // still lands in history (uncredited in the grid until an alias is added).
    const code = normalizeVaccineName(printed) ?? slugifyVaccine(printed);
    out.push({
      vaccine: code,
      date,
      dose_label: clip(it?.dose_label, 60),
      notes: clip(it?.notes, 200),
    });
  }
  // Collapse duplicate (vaccine, date) rows a card might repeat.
  const seen = new Set<string>();
  return out
    .filter((r) => {
      const k = `${r.vaccine}|${r.date}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.date.localeCompare(b.date));
}
