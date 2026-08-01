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

// The CONTEXT a curated symptom leads with (issue #714). Every mount of the symptom bar
// leads with its own context's slugs: the illness surfaces with `illness`, the Cycle
// surface with `cycle`; `general` symptoms (headache, fatigue, …) are context-neutral and
// follow. The tag is a picker-ORDER lever only — any symptom can still be logged anywhere
// on any day (multi-membership is correct by construction, #714), and it never restricts
// the vocabulary. Validated by lib/__tests__/symptoms-dataset.test.ts.
export type SymptomDomain = "illness" | "cycle" | "general";

export const SYMPTOM_DOMAINS: readonly SymptomDomain[] = [
  "illness",
  "cycle",
  "general",
];

export interface Symptom {
  // Stable slug — symptom_logs.symptom for a curated entry. NEVER changes once
  // shipped (renames are display-only). Lowercase snake_case.
  slug: string;
  // Display name for the log chip / timeline label.
  label: string;
  // Optional emoji shown on the chip.
  icon?: string;
  // Which context this symptom leads with (see SymptomDomain). Required on every curated
  // entry; custom free-text symptoms carry no domain (they're not in this catalog).
  domain: SymptomDomain;
  // An ORDINAL scale of the symptom's own, replacing the default mild → very severe
  // labels for the stored 1–4 (issue #1680). A categorical daily observation — cervical
  // mucus is dry / sticky / creamy / egg-white — is genuinely ordinal (ascending fertility
  // signal), so it reuses symptom_logs rather than earning a parallel store; what it
  // cannot reuse is the SEVERITY vocabulary, because "moderate mucus" means nothing.
  // Exactly MAX_SYMPTOM_SEVERITY entries when present, index 0 = severity 1.
  scale?: string[];
  // Kept out of the generic one-tap PICKER (issue #1680). An observation with its own
  // dedicated entry point — and its own scale — would otherwise appear in the everyday
  // symptom bar asking for a severity it doesn't have. It stays fully loggable, readable,
  // and labelled everywhere; only the generic picker skips it.
  pickerHidden?: boolean;
}

export const SYMPTOMS: Symptom[] = (symptomsData as { symptoms: Symptom[] })
  .symptoms;

const BY_SLUG = new Map(SYMPTOMS.map((s) => [s.slug, s]));

export function symptomBySlug(slug: string): Symptom | undefined {
  return BY_SLUG.get(slug);
}

// Whether a symptom belongs in the generic one-tap picker (see Symptom.pickerHidden).
export function isPickerSymptom(s: Symptom): boolean {
  return !s.pickerHidden;
}

// The curated catalog MINUS the entries with their own dedicated entry point — the list
// every generic symptom picker renders (the log bar, the Telegram quick-log grid).
export const PICKER_SYMPTOMS: Symptom[] = SYMPTOMS.filter(isPickerSymptom);

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

// The curated LABELS, catalog order — the option source for every free-text symptom
// entry point (issue #1676): the log bar's "add another symptom" field and the
// medication side-effect fields, which describe the same human vocabulary. Typing a
// near-miss ("Head ache") used to mint a custom key sitting beside the curated
// `headache`; offering the labels turns those near-misses into exact matches that
// resolveSymptomKey() collapses onto the curated slug. Free text stays allowed —
// the catalog suggests, it never gates.
export function symptomLabelOptions(): string[] {
  // Picker-hidden entries are excluded: they have their own dedicated entry point and
  // their own ordinal scale, so offering the label here would route a free-text match
  // into a store expecting a severity it doesn't have (#1680).
  return PICKER_SYMPTOMS.map((s) => s.label);
}

// The curated slugs in a given context, catalog order preserved — the per-mount "lead
// with these" list (issue #714). Used to build a domain-led picker order.
export function symptomSlugsInDomain(domain: SymptomDomain): string[] {
  return SYMPTOMS.filter((s) => s.domain === domain).map((s) => s.slug);
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

// The label for a stored 1–4 ON A GIVEN symptom (issue #1680): a curated entry may carry
// its own ordinal `scale` (cervical mucus reads dry/sticky/creamy/egg-white, never
// mild/moderate/severe), and everything else falls back to the shared severity vocabulary.
// The ONE label resolution — every reader of a stored severity goes through it, so a
// scaled symptom can never render as a severity on one surface and its own scale on
// another.
export function severityLabelFor(key: string, n: number): string {
  const scale = BY_SLUG.get(key)?.scale;
  if (scale && n >= MIN_SYMPTOM_SEVERITY && n <= scale.length) return scale[n - 1];
  return severityLabel(n);
}
