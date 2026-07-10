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
  return {
    name: p.name.replace(/\s+/g, " ").trim(),
    type: p.type === "individual" ? "individual" : "organization",
    npi,
    identifier: clean(p.identifier),
    phone: clean(p.phone),
    address: clean(p.address),
  };
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
