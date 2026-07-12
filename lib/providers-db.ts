import { db, writeTx } from "./db";
import type { Provider, ProviderType } from "./types";
import {
  cleanProviderInput,
  pickReusableProviderId,
  providerDedupKey,
  type ProviderInput,
} from "./providers";
import {
  PROVIDER_LINK_COLUMNS,
  planProviderMerge,
  providerLinkTables,
  type ProviderMergeImpact,
} from "./provider-merge";

// The shared providers registry data layer. GLOBAL, like
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
  return writeTx((): number => {
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
}

// Manual-entry resolver for the provider picker (create-on-type). Reuses an
// existing shared provider when the typed name UNAMBIGUOUSLY matches one, else
// creates a distinct row. Returns null for a blank input (unlinks). `type` is the
// kind the picker is entering under (organization by default); it lets the resolver
// prefer a same-type match and, critically, REFUSE to blind-reuse when the name is
// ambiguous — pickReusableProviderId (#534) is the pure decision. Before #534 this
// took the lowest-id name match unconditionally, silently merging two distinct
// same-named providers onto one row; now an ambiguous name creates/resolves a
// distinct row via the dedup key (which still converges a repeat of the SAME
// name+type, so manual re-entry stays idempotent).
export function resolveProviderIdByName(
  name: string,
  type: ProviderType = "organization"
): number | null {
  const trimmed = (name ?? "").replace(/\s+/g, " ").trim();
  if (!trimmed) return null;
  const matches = db
    .prepare(
      "SELECT id, type FROM providers WHERE name = ? COLLATE NOCASE ORDER BY id"
    )
    .all(trimmed) as { id: number; type: ProviderType }[];
  const reuse = pickReusableProviderId(type, matches);
  if (reuse != null) return reuse;
  return resolveProviderId({ name: trimmed, type });
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

// Update a shared provider's identity fields (issue #275). GLOBAL mutation — the
// providers row is shared across every profile, so the caller (the server action)
// gates on requireAdmin(), the same posture as the other global settings writes.
// The dedup_key is recomputed so a corrected NPI/name keeps the row deduplicating
// correctly against future imports; a UNIQUE(dedup_key) collision with a DIFFERENT
// existing provider surfaces as a thrown error the action turns into a friendly
// "already exists — merge instead" message.
export function updateProviderIdentity(id: number, input: ProviderInput): void {
  const p = cleanProviderInput(input);
  if (!p) throw new Error("A provider needs a name.");
  const key = providerDedupKey(p);
  const clash = db
    .prepare("SELECT id FROM providers WHERE dedup_key = ? AND id <> ?")
    .get(key, id) as { id: number } | undefined;
  if (clash)
    throw new Error(
      "Another provider already matches this identity — merge the duplicates instead."
    );
  db.prepare(
    `UPDATE providers
        SET name = ?, type = ?, npi = ?, identifier = ?, phone = ?, address = ?, dedup_key = ?
      WHERE id = ?`
  ).run(p.name, p.type, p.npi, p.identifier, p.phone, p.address, key, id);
}

// Count-only impact of absorbing `duplicateId` (issue #275 confirm dialog). GLOBAL
// by design: it counts DISTINCT rows per linked table across EVERY profile plus the
// number of distinct profiles touched — the admin-only merge shows this as counts
// only ("14 records · 3 visits across 2 profiles"), never cross-profile detail. The
// per-table statements interpolate the bound PROVIDER_LINK_COLUMNS table/columns,
// so no literal owned-table name appears — these are deliberately global aggregates
// (across every profile), not per-profile reads, and carry no profile_id filter.
export function getProviderMergeImpact(
  duplicateId: number
): ProviderMergeImpact {
  const perTable: { table: string; count: number }[] = [];
  const profiles = new Set<number>();
  let total = 0;
  for (const { table, columns } of providerLinkTables()) {
    const pred = columns.map((c) => `${c} = ?`).join(" OR ");
    const args = columns.map(() => duplicateId);
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${pred}`)
      .get(...args) as { n: number };
    perTable.push({ table, count: row.n });
    total += row.n;
    const pids = db
      .prepare(`SELECT DISTINCT profile_id AS pid FROM ${table} WHERE ${pred}`)
      .all(...args) as { pid: number }[];
    for (const { pid } of pids) profiles.add(pid);
  }
  return { perTable, profiles: profiles.size, total };
}

// Merge one provider into another (issue #275). Re-points EVERY provider link
// (provider_id AND encounters.location_provider_id) from the absorbed row to the
// survivor in ONE transaction, then deletes the absorbed row — the row-ops
// convention (#199/#201): a merge that forgot a link column would strand rows on a
// deleted provider. GLOBAL operation (re-points across all profiles), so the caller
// gates on requireAdmin(). The re-point UPDATE is a runtime expression over the
// bound PROVIDER_LINK_COLUMNS list (allowlisted in the profile-scoping test — the
// merge is intentionally profile-agnostic). Idempotent link-wise: a survivor that
// already owns some rows is unaffected. Throws on a self-merge or a missing row.
export function mergeProviders(survivorId: number, duplicateId: number): void {
  const plan = planProviderMerge(survivorId, duplicateId);
  if (!plan.ok) throw new Error(plan.reason);
  const both = db
    .prepare("SELECT id FROM providers WHERE id IN (?, ?)")
    .all(survivorId, duplicateId) as { id: number }[];
  if (both.length !== 2) throw new Error("Both providers must exist to merge.");
  writeTx(() => {
    for (const { table, column } of PROVIDER_LINK_COLUMNS) {
      db.prepare(`UPDATE ${table} SET ${column} = ? WHERE ${column} = ?`).run(
        survivorId,
        duplicateId
      );
    }
    db.prepare("DELETE FROM providers WHERE id = ?").run(duplicateId);
  });
}
