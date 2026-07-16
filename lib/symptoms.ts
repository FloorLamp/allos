// Typed accessors over the curated symptom vocabulary (lib/symptoms.json, issue
// #799). Pure — no DB/network — so it's importable from the pure test tier, the query
// layer, and client components alike. The committed JSON is hand-authored + human-
// reviewable (validated structurally by lib/__tests__/symptoms-dataset.test.ts).
//
// A logged symptom is keyed by either a curated SLUG (from the catalog below) or a
// free-text CUSTOM name (stored inline as its normalized text). The catalog is only
// the one-tap shortcut list; custom names extend the vocabulary per-profile and carry
// the #203 name-keyed hygiene (rename/delete re-keys or cleans the dependent log rows).

import symptomsData from "./symptoms.json";

export interface Symptom {
  // Stable slug — symptom_logs.symptom for a curated entry. NEVER changes once
  // shipped (renames are display-only). Lowercase snake_case.
  slug: string;
  // Display name for the log chip / timeline label.
  label: string;
  // Optional emoji shown on the chip.
  icon?: string;
}

export const SYMPTOMS: Symptom[] = (symptomsData as { symptoms: Symptom[] })
  .symptoms;

const BY_SLUG = new Map(SYMPTOMS.map((s) => [s.slug, s]));

export function symptomBySlug(slug: string): Symptom | undefined {
  return BY_SLUG.get(slug);
}

// A stored symptom key is "curated" iff it matches a catalog slug; everything else
// is a custom free-text name.
export function isCuratedSymptom(key: string): boolean {
  return BY_SLUG.has(key);
}

export function isCustomSymptomKey(key: string): boolean {
  return !BY_SLUG.has(key);
}

export function symptomSlugs(): string[] {
  return SYMPTOMS.map((s) => s.slug);
}

// The display name for a stored key: the catalog label for a curated slug, else the
// custom key verbatim (the #203 discipline — a logged row under an old/unknown slug
// still renders, never throws).
export function symptomLabel(key: string): string {
  return BY_SLUG.get(key)?.label ?? key;
}

// Canonicalize a custom symptom name: trim + collapse internal whitespace, capped so a
// pasted paragraph can't bloat the column. Paired with the symptom_logs
// UNIQUE(profile_id, date, symptom), this makes " Ear  ache " and "Ear ache" resolve
// to one per-day row.
export function normalizeSymptomName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, 80);
}

// Resolve a user-entered symptom (a chip slug OR free text) to its STORED key. A value
// that matches a curated slug — or a curated LABEL, case-insensitively — collapses onto
// the curated slug so a typed "Fever" never shadows the catalog's `fever`; anything else
// is a normalized custom name. Empty input → null (nothing to log).
export function resolveSymptomKey(input: string): string | null {
  const raw = input.trim();
  if (!raw) return null;
  if (BY_SLUG.has(raw)) return raw;
  const lower = raw.toLowerCase();
  for (const s of SYMPTOMS) {
    if (s.slug === lower || s.label.toLowerCase() === lower) return s.slug;
  }
  const norm = normalizeSymptomName(raw);
  return norm || null;
}

// The 1–4 severity scale. Ordinal (mild → very severe); the log keeps a day's WORST
// (highest) severity on a re-tap, and an explicit edit may lower it (#799).
export const SYMPTOM_SEVERITY_LEVELS = [
  { value: 1, label: "Mild" },
  { value: 2, label: "Moderate" },
  { value: 3, label: "Severe" },
  { value: 4, label: "Very severe" },
] as const;

export const MIN_SYMPTOM_SEVERITY = 1;
export const MAX_SYMPTOM_SEVERITY = 4;

export function isValidSeverity(n: number): boolean {
  return (
    Number.isInteger(n) &&
    n >= MIN_SYMPTOM_SEVERITY &&
    n <= MAX_SYMPTOM_SEVERITY
  );
}

export function severityLabel(n: number): string {
  return (
    SYMPTOM_SEVERITY_LEVELS.find((l) => l.value === n)?.label ?? `Level ${n}`
  );
}
