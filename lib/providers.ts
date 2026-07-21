import type { ProviderType } from "./types";

// Pure normalization + global dedup for the shared providers registry.
// No DB/network — the DB resolver (lib/providers-db) computes the same key
// and INSERTs on a UNIQUE(dedup_key) index, so "resolve or create" is idempotent
// and a reprocess never coins a duplicate provider.

// A provider captured from a health record (CCD performer / Care Team) or entered
// by hand, before it's resolved into a shared providers row.
export interface ProviderInput {
  name: string;
  type: ProviderType;
  // NPI is authoritative for dedup when present. `identifier` is any other stable
  // id (org/EMR), authority-qualified as `<root-OID>:<extension>` so the same
  // local id under different assigning authorities stays distinct. phone/address
  // are captured from the CCD when carried.
  npi?: string | null;
  identifier?: string | null;
  phone?: string | null;
  address?: string | null;
  // Specialty (issue #1056), captured from a source document or typed by hand. NOT
  // part of the dedup key — specialty is descriptive, not identity — so two rows that
  // differ only in specialty still converge; the resolver refreshes it in place.
  specialtyCode?: string | null;
  specialty?: string | null;
}

// Collapse internal whitespace and lowercase for a stable comparison key.
// Punctuation is kept — org names like "EXAMPLE MEDICAL CARE, PC (CLIA#: 00D...)"
// are legitimately distinct on it.
export function normalizeProviderName(name: string): string {
  return name.replace(/\s+/g, " ").trim().toLowerCase();
}

// Keep only the digits of an NPI so "1234567890" and " 1234567890 " collapse.
export function normalizeNpi(npi: string | null | undefined): string {
  return (npi ?? "").replace(/\D/g, "");
}

// The GLOBAL dedup key. An NPI (or other identifier) is authoritative — two rows
// with the same NPI are the same provider whatever the spelling — so it keys on
// `npi:<digits>` when present, else `id:<identifier>`, else `name:<type>:<name>`
// (type folded in only on the name path so an org and a person that happen to
// share a name don't collapse). Deterministic + tested; the DB UNIQUE index on
// this value is what makes concurrent/repeat imports converge on one row.
export function providerDedupKey(p: ProviderInput): string {
  const npi = normalizeNpi(p.npi);
  if (npi) return `npi:${npi}`;
  const ident = (p.identifier ?? "").trim().toLowerCase();
  if (ident) return `id:${ident}`;
  return `name:${p.type}:${normalizeProviderName(p.name)}`;
}

// A candidate is usable only when it has a non-blank name — a bare id with no
// name carries nothing to show, so it's dropped rather than registered.
export function isUsableProvider(
  p: { name?: string | null } | null | undefined
): p is ProviderInput {
  return !!p && typeof p.name === "string" && p.name.trim().length > 0;
}

// Normalize a raw provider candidate into a clean ProviderInput (trimmed name,
// blank strings → null), or null when it carries no usable name. Shared by the
// CCD import and the manual-entry server actions so both register identically.
export function cleanProviderInput(
  p: ProviderInput | null | undefined
): ProviderInput | null {
  if (!isUsableProvider(p)) return null;
  const clean = (v: string | null | undefined) => {
    const s = (v ?? "").replace(/\s+/g, " ").trim();
    return s || null;
  };
  const npi = normalizeNpi(p.npi) || null;
  const code = (p.specialtyCode ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .toUpperCase();
  return {
    name: p.name.replace(/\s+/g, " ").trim(),
    type: p.type === "individual" ? "individual" : "organization",
    npi,
    identifier: clean(p.identifier),
    phone: clean(p.phone),
    address: clean(p.address),
    specialtyCode: code || null,
    specialty: clean(p.specialty),
  };
}

// The write-time reuse decision for a manually typed provider name (issue #534).
// resolveProviderIdByName reuses an EXISTING shared row when the typed name matches
// one, but must never silently collapse two GENUINELY DISTINCT providers that happen
// to share a name (a cardiologist "Dr. Smith" vs a dentist; two "City Medical"
// clinics in different towns). Given every registry row that shares the typed name
// (case-insensitive) plus the `type` the manual picker is creating under, decide
// which existing row — if any — is safe to reuse:
//   • exactly one row of the SAME type → reuse it (the strong signal a name-only
//     entry carries — a typed lab name reuses the one lab org of that name);
//   • no same-type row but exactly one row of ANY type → reuse it (preserves
//     "typing a known clinician's name reuses their row" even when the stored type
//     differs from the picker default);
//   • otherwise the name is AMBIGUOUS (two+ rows share it, or it splits across
//     types) → return null so the caller creates/resolves a DISTINCT row instead of
//     blind-attaching to an arbitrary `ORDER BY id LIMIT 1` winner.
// Exclusion discipline (#482): when the match can't be pinned uniquely, UNDER-
// collapsing (a fresh duplicate the merge UI can later fix) beats mis-linking a
// record onto the wrong distinct provider. Pure + unit-tested; the DB half only
// supplies the candidate rows.
export function pickReusableProviderId(
  type: ProviderType,
  matches: readonly { id: number; type: ProviderType }[]
): number | null {
  const sameType = matches.filter((m) => m.type === type);
  if (sameType.length === 1) return sameType[0].id;
  if (sameType.length === 0 && matches.length === 1) return matches[0].id;
  return null;
}

// Dedup a list of candidates by their global key, keeping the first (richest is
// caller's responsibility — first-writer-wins matches the DB INSERT OR IGNORE).
export function dedupeProviders(inputs: ProviderInput[]): ProviderInput[] {
  const seen = new Set<string>();
  const out: ProviderInput[] = [];
  for (const raw of inputs) {
    const p = cleanProviderInput(raw);
    if (!p) continue;
    const key = providerDedupKey(p);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(p);
  }
  return out;
}
