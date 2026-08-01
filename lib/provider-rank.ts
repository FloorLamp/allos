// The provider picker and specialty picker ORDER (issue #1677). Pure — no DB, no
// network; `lib/queries/provider-options.ts` resolves the facts and calls in here.
//
// `getPickerProviders()` returns the registry `ORDER BY name COLLATE NOCASE`, so every
// ProviderCombobox on every surface opens on "Aaronson" — a name the family may have
// seen once, ahead of the PCP they see four times a year. The registry is shared across
// profiles, so alphabetical is the only order the ROW itself can offer; relevance has to
// come from the acting profile's own links.
//
// Two rankers live here because they are the same domain question asked twice:
//   - which provider does this profile actually see (recency-decayed frequency over the
//     profile's own dated provider links — the shared `rankByRecentFrequency`)
//   - which specialty does a person actually type (curated common head, with the
//     profile's own specialties leading when it has any)
//
// ORDERING ONLY: membership never changes and everything stays reachable by search.

import { NUCC_LABEL_OPTIONS } from "./nucc-taxonomy";
import { rankByFrequency, rankByRecentFrequency } from "./rank-by-frequency";

// One dated link from a profile-owned record to a provider. Every provider-bearing
// table contributes its own rows (encounters, labs, meds, immunizations, procedures,
// care plan, appointments, imaging, vision, dental, skin) — a provider seen across
// several domains outranks one seen once, and the decay makes this year's clinician
// lead a clinician retired from the family's care years ago.
export interface ProviderUse {
  providerId: number;
  date: string; // YYYY-MM-DD
}

// Rank registry rows by how much this profile actually uses them, newest-weighted.
// `providers` arrives in its existing alphabetical order, which stays the tie-break —
// so a profile with NO links gets its input back byte for byte. Providers the profile
// has never linked keep alphabetical order behind the ones it has.
//
// Ids are the identity (two providers can share a display name — #531/#534), so the
// ranking is done over id strings and mapped back to rows.
export function rankProvidersByUse<T extends { id: number }>(
  providers: readonly T[],
  uses: readonly ProviderUse[],
  today: string
): T[] {
  if (uses.length === 0) return [...providers];
  const byId = new Map(providers.map((p) => [String(p.id), p]));
  const occurrences = uses
    .filter((u) => byId.has(String(u.providerId)) && u.date)
    .map((u) => ({ name: String(u.providerId), date: u.date }));
  if (occurrences.length === 0) return [...providers];
  const order = rankByRecentFrequency(
    providers.map((p) => String(p.id)),
    occurrences,
    today
  );
  const out: T[] = [];
  for (const key of order) {
    const row = byId.get(key);
    if (row) out.push(row);
  }
  return out;
}

// The curated common-specialty head — what a household actually records, ahead of the
// NUCC taxonomy's alphabet (which opens on "Allergy & Immunology"/"Anesthesiology").
// Every entry must be a real curated NUCC label (pinned by
// lib/__tests__/provider-rank.test.ts). Ordering only; the full label set stays.
export const COMMON_SPECIALTIES: readonly string[] = [
  "Family Medicine",
  "Internal Medicine",
  "Pediatrics",
  "Dentistry",
  "Optometry",
  "Obstetrics & Gynecology",
  "Dermatology",
  "Physical Therapist",
  "Cardiology",
  "Orthopaedic Surgery",
  "Psychiatry",
  "Psychologist",
  "Ophthalmology",
  "Gastroenterology",
  "Otolaryngology",
  "Endocrinology",
  "Neurology",
  "Urology",
  "Allergy & Immunology",
  "Pharmacy",
  "Clinic / Center",
];

// The curated specialty options with the common head in front and the remaining NUCC
// labels A–Z behind it — what a profile with no recorded specialties sees.
let curatedSpecialtyCache: string[] | null = null;
export function curatedSpecialtyOptions(): string[] {
  if (curatedSpecialtyCache) return curatedSpecialtyCache;
  const known = new Set(NUCC_LABEL_OPTIONS);
  const head = COMMON_SPECIALTIES.filter((s) => known.has(s));
  const taken = new Set(head);
  curatedSpecialtyCache = [
    ...head,
    ...NUCC_LABEL_OPTIONS.filter((s) => !taken.has(s)),
  ];
  return curatedSpecialtyCache;
}

// The specialty picker order (#1677): the specialties this profile's own providers
// already carry lead, then the curated head, then the rest A–Z. `used` is the recorded
// specialty strings; a specialty outside the curated labels (free text, or a label an
// import carried verbatim) is appended by its own count, so the family's own vocabulary
// leads its own picker. No usage ⇒ `curatedSpecialtyOptions()` byte for byte.
export function rankedSpecialtyOptions(used: readonly string[]): string[] {
  const counts = new Map<string, { name: string; c: number }>();
  const canonical = new Map(
    NUCC_LABEL_OPTIONS.map((s) => [s.toLowerCase(), s])
  );
  for (const raw of used) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    const name = canonical.get(key) ?? value;
    const prev = counts.get(key);
    if (prev) prev.c += 1;
    else counts.set(key, { name, c: 1 });
  }
  return rankByFrequency(curatedSpecialtyOptions(), [...counts.values()]);
}
