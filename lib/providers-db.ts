import { db } from "./db";
import type { Provider } from "./types";
import {
  cleanProviderInput,
  providerDedupKey,
  type ProviderInput,
} from "./providers";

// The shared providers registry data layer (issue #178). GLOBAL, like
// logins/profiles — a family shares one "Quest Diagnostics" / "Dr. Smith", so
// these statements are intentionally NOT profile-scoped (and the providers table
// is excluded from the profile-scoping leak test for the same reason the auth
// tables are). Records link to a provider via a nullable provider_id FK on their
// own profile-owned row; that link is set/read through profile-scoped queries.

// Resolve a candidate provider to its shared row id, creating the row when new.
// Idempotent: the dedup_key UNIQUE index (INSERT OR IGNORE) makes a repeat import
// converge on the existing row, so a reprocess never duplicates a provider.
// Returns null when the candidate carries no usable name.
export function resolveProviderId(
  input: ProviderInput | null | undefined
): number | null {
  const p = cleanProviderInput(input);
  if (!p) return null;
  const key = providerDedupKey(p);
  const insert = db.transaction((): number => {
    db.prepare(
      `INSERT OR IGNORE INTO providers
         (name, type, npi, identifier, phone, address, dedup_key)
       VALUES (?,?,?,?,?,?,?)`
    ).run(p.name, p.type, p.npi, p.identifier, p.phone, p.address, key);
    const row = db
      .prepare("SELECT id FROM providers WHERE dedup_key = ?")
      .get(key) as { id: number } | undefined;
    return row!.id;
  });
  return insert();
}

// Manual-entry resolver for the provider picker (create-on-type). Links to an
// existing shared provider when the typed name matches one (case-insensitive,
// whatever its type — so typing a known clinician's name reuses their row), else
// creates a new organization row. Returns null for a blank input (unlinks).
export function resolveProviderIdByName(name: string): number | null {
  const trimmed = (name ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  const existing = db
    .prepare(
      "SELECT id FROM providers WHERE name = ? COLLATE NOCASE ORDER BY id LIMIT 1"
    )
    .get(trimmed) as { id: number } | undefined;
  if (existing) return existing.id;
  return resolveProviderId({ name: trimmed, type: "organization" });
}

// The full shared registry, alphabetical. Used to seed the provider picker's
// combobox and the (optional) providers list view.
export function getProviders(): Provider[] {
  return db
    .prepare(
      `SELECT id, name, type, npi, identifier, phone, address, created_at
         FROM providers ORDER BY name COLLATE NOCASE`
    )
    .all() as Provider[];
}

// One provider by id (or undefined). Global lookup — providers are shared.
export function getProvider(id: number): Provider | undefined {
  return db
    .prepare(
      `SELECT id, name, type, npi, identifier, phone, address, created_at
         FROM providers WHERE id = ?`
    )
    .get(id) as Provider | undefined;
}

// Just the display names, for the datalist that powers the create-on-type picker.
export function getProviderNames(): string[] {
  return getProviders().map((p) => p.name);
}
