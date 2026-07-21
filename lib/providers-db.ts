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
import {
  resolveExactIndividualProvider,
  type RegistryProviderRow,
} from "./prescriber-link";

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
         (name, type, npi, identifier, phone, address, specialty_code, specialty,
          dedup_key)
       VALUES (?,?,?,?,?,?,?,?,?)`
    ).run(
      p.name,
      p.type,
      p.npi,
      p.identifier,
      p.phone,
      p.address,
      p.specialtyCode ?? null,
      p.specialty ?? null,
      key
    );
    const row = db
      .prepare("SELECT id FROM providers WHERE dedup_key = ?")
      .get(key) as { id: number } | undefined;
    const id = row!.id;
    // Refresh the richer descriptive fields on an EXISTING row from this import
    // (issues #1056/#1057/#1058). Only overwrite when the incoming candidate carries
    // a value (a sparse re-import must not null good data):
    //   • specialty_code / specialty — always refreshed when present (#1056);
    //   • phone / address — refreshed only when NOT manually edit-locked
    //     (contact_edited = 0); import-vs-import stays last-write-wins (#1058/#467);
    //   • archived → 0 — a re-import that resolves here proves the provider is active
    //     again, so it UN-ARCHIVES (#1057, the one behavioral subtlety pinned by test).
    if (p.specialtyCode)
      db.prepare(`UPDATE providers SET specialty_code = ? WHERE id = ?`).run(
        p.specialtyCode,
        id
      );
    if (p.specialty)
      db.prepare(`UPDATE providers SET specialty = ? WHERE id = ?`).run(
        p.specialty,
        id
      );
    if (p.phone)
      db.prepare(
        `UPDATE providers SET phone = ? WHERE id = ? AND contact_edited = 0`
      ).run(p.phone, id);
    if (p.address)
      db.prepare(
        `UPDATE providers SET address = ? WHERE id = ? AND contact_edited = 0`
      ).run(p.address, id);
    db.prepare(
      `UPDATE providers SET archived = 0 WHERE id = ? AND archived = 1`
    ).run(id);
    return id;
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

// Edit-round-trip resolver (issue #601), mirroring the #467 resolveOnHandWrite
// compare-and-set. An edit form round-trips the provider link through the NAME
// string only; re-resolving from scratch on every save runs the #534 ambiguity
// policy, which returns a DISTINCT new row when the name matches 2+ providers —
// so saving an UNRELATED field on a record linked to an ambiguously-named provider
// would silently relink it to a freshly-coined duplicate. Guard it: the form ALSO
// submits the id + name it LOADED with, and we re-resolve by name ONLY when the
// submitted name actually DIFFERS from the loaded one (whitespace-/case-insensitive,
// matching the registry's NOCASE dedup); an untouched field keeps the existing id.
// A genuine name change still re-resolves (create-on-type), and clearing the field
// (submitted blank ≠ loaded name) unlinks via resolveProviderIdByName's null.
export function resolveProviderOnEdit(
  loadedId: number | null,
  loadedName: string,
  submittedName: string,
  type: ProviderType = "organization"
): number | null {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  if (norm(loadedName) === norm(submittedName)) return loadedId;
  return resolveProviderIdByName(submittedName, type);
}

// Exact write-time resolution of a free-text prescriber to an INDIVIDUAL registry row
// (#1051 ask 2), entity-type-aware. UNLIKE resolveProviderIdByName it NEVER creates a
// row and NEVER links to an organization — it matches only an existing individual-type
// row by exact normalized name (or NPI), and returns null on ambiguity / a near-miss /
// an org-only name (those are surfaced by the #1045 suggest-and-accept detector, never
// linked silently). The registry is small + global, so fetching the whole table and
// deciding in the pure engine (resolveExactIndividualProvider) is both correct and
// cheap. Returns the linked provider id, or null.
export function resolveExactPrescriberId(
  text: string | null | undefined,
  npi: string | null | undefined = null
): number | null {
  const t = (text ?? "").replace(/\s+/g, " ").trim();
  const nn = (npi ?? "").replace(/\D/g, "");
  if (!t && !nn) return null;
  const rows = db
    .prepare("SELECT id, type, name, npi FROM providers")
    .all() as RegistryProviderRow[];
  return resolveExactIndividualProvider(t, nn, rows);
}

// The full shared registry, alphabetical. Used to seed the provider picker's
// combobox and the (optional) providers list view.
const PROVIDER_COLUMNS = `id, name, type, npi, identifier, phone, address,
        specialty_code, specialty, archived, contact_edited, created_at`;

export function getProviders(): Provider[] {
  return db
    .prepare(
      `SELECT ${PROVIDER_COLUMNS}
         FROM providers ORDER BY name COLLATE NOCASE`
    )
    .all() as Provider[];
}

// One provider by id (or undefined). Global lookup — providers are shared.
export function getProvider(id: number): Provider | undefined {
  return db
    .prepare(`SELECT ${PROVIDER_COLUMNS} FROM providers WHERE id = ?`)
    .get(id) as Provider | undefined;
}

// Just the display names, for the datalist that powers the create-on-type picker.
// Archived providers are EXCLUDED from suggestions (issue #1057) — a retired
// clinician shouldn't be offered — but a user can still type an exact archived name,
// which resolveProviderIdByName resolves to the existing row.
export function getProviderNames(): string[] {
  return (
    db
      .prepare(
        `SELECT name FROM providers WHERE archived = 0 ORDER BY name COLLATE NOCASE`
      )
      .all() as { name: string }[]
  ).map((r) => r.name);
}

// Archive / un-archive a provider (issue #1057). Instance-level lifecycle flag; the
// GLOBAL mutation is admin-gated at the action. Archiving NEVER touches history —
// every FK'd record keeps its link and renders the provider name as before.
export function setProviderArchived(id: number, archived: boolean): void {
  db.prepare(`UPDATE providers SET archived = ? WHERE id = ?`).run(
    archived ? 1 : 0,
    id
  );
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
  const friendlyClash =
    "Another provider already matches this identity — merge the duplicates instead.";
  // Check-then-write in ONE transaction (issue #601): dedup_key is UNIQUE, and the
  // SELECT clash-check + UPDATE previously ran as two autocommit statements — with
  // concurrent writers (web/tick/sidecar, or two admins) the second could pass the
  // check, then have its UPDATE throw a raw `UNIQUE constraint failed` that the action
  // surfaced verbatim. writeTx serializes it (better-sqlite3 BEGIN IMMEDIATE), the
  // same convention resolveProviderId/mergeProviders use; the SQLITE_CONSTRAINT_UNIQUE
  // catch is belt-and-suspenders, re-mapping a lost race to the friendly message.
  try {
    writeTx(() => {
      const clash = db
        .prepare("SELECT id FROM providers WHERE dedup_key = ? AND id <> ?")
        .get(key, id) as { id: number } | undefined;
      if (clash) throw new Error(friendlyClash);
      // The manual identity card is the edit-lock trigger (issue #1058): asserting a
      // phone/address here sets contact_edited = 1, so a later import upsert preserves
      // it (see resolveProviderId). Only lock when the user actually supplied a
      // contact value — clearing both leaves the flag as-is so imports can repopulate.
      const locksContact = !!(p.phone || p.address);
      db.prepare(
        `UPDATE providers
            SET name = ?, type = ?, npi = ?, identifier = ?, phone = ?, address = ?,
                specialty_code = ?, specialty = ?, dedup_key = ?
                ${locksContact ? ", contact_edited = 1" : ""}
          WHERE id = ?`
      ).run(
        p.name,
        p.type,
        p.npi,
        p.identifier,
        p.phone,
        p.address,
        p.specialtyCode ?? null,
        p.specialty ?? null,
        key,
        id
      );
    });
  } catch (err) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as { code?: string }).code === "SQLITE_CONSTRAINT_UNIQUE"
    )
      throw new Error(friendlyClash);
    throw err;
  }
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
    // Re-key affiliation edges (issue #1055) — the ONE provider link the generic
    // loop above can't do, because provider_affiliations has a UNIQUE(individual_id,
    // organization_id) pair a plain re-point UPDATE would collide on, and re-keying
    // can create a self-edge (survivor↔survivor). UPDATE OR IGNORE skips a would-be
    // duplicate (leaving the stale duplicate-keyed row), the follow-up DELETE clears
    // those, and the final DELETE drops any self-edge the re-key produced. These two
    // columns are the documented exception on the merge-link reflection test.
    db.prepare(
      `UPDATE OR IGNORE provider_affiliations SET individual_id = ? WHERE individual_id = ?`
    ).run(survivorId, duplicateId);
    db.prepare(
      `UPDATE OR IGNORE provider_affiliations SET organization_id = ? WHERE organization_id = ?`
    ).run(survivorId, duplicateId);
    db.prepare(
      `DELETE FROM provider_affiliations WHERE individual_id = ? OR organization_id = ?`
    ).run(duplicateId, duplicateId);
    db.prepare(
      `DELETE FROM provider_affiliations WHERE individual_id = organization_id`
    ).run();
    // Reconcile the survivor's descriptive/lifecycle fields from the absorbed row
    // (row-ops side-state): keep the survivor's non-null specialty, else inherit the
    // absorbed one (#1056); the pair is ARCHIVED only if BOTH were (an archived +
    // active merge stays active, #1057); the contact stays LOCKED if EITHER was
    // edited, so imports keep respecting the manual correction (#1058).
    const dup = db
      .prepare(
        `SELECT specialty_code, specialty, archived, contact_edited
           FROM providers WHERE id = ?`
      )
      .get(duplicateId) as
      | {
          specialty_code: string | null;
          specialty: string | null;
          archived: number;
          contact_edited: number;
        }
      | undefined;
    if (dup) {
      db.prepare(
        `UPDATE providers
            SET specialty_code = COALESCE(specialty_code, ?),
                specialty = COALESCE(specialty, ?),
                archived = CASE WHEN archived = 1 AND ? = 1 THEN 1 ELSE 0 END,
                contact_edited = CASE WHEN contact_edited = 1 OR ? = 1 THEN 1 ELSE 0 END
          WHERE id = ?`
      ).run(
        dup.specialty_code,
        dup.specialty,
        dup.archived,
        dup.contact_edited,
        survivorId
      );
    }
    db.prepare("DELETE FROM providers WHERE id = ?").run(duplicateId);
  });
}
