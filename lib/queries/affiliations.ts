import { db, writeTx } from "../db";
import type { AppRoute } from "../hrefs";
import type { ProviderType } from "../types";
import {
  affiliationPairKey,
  suggestAffiliations,
  type CoOccurrence,
  type SuggestedAffiliation,
} from "../affiliations";
import { getProviderActivityTotal } from "./providers";

// DB read/derive + decision-persistence for provider ↔ provider AFFILIATIONS
// (issue #1055). The suggestion MATH is the pure engine (lib/affiliations.ts); this
// module gathers co-occurrence + edge/decision rows, derives suggestions at READ
// time, and applies an accepted/declined decision onto the GLOBAL
// provider_affiliations table.
//
// GLOBAL, like providers-db: the affiliation edge is a fact about two shared registry
// rows, so these statements are intentionally NOT profile-scoped (provider_affiliations
// carries no profile_id — the profile-scoping test never sees it). The ONLY
// per-profile read here is the co-occurrence source (the acting profile's encounters),
// so a member never learns another profile's visit pairings.

// ── Edges + decisions (global) ────────────────────────────────────────────────

// Every stored affiliation row (linked OR declined) as a pair key, so the suggester
// excludes a pair that already has any decision.
function affiliationKeysByStatus(status: "linked" | "declined"): Set<string> {
  const rows = db
    .prepare(
      `SELECT individual_id, organization_id FROM provider_affiliations WHERE status = ?`
    )
    .all(status) as { individual_id: number; organization_id: number }[];
  return new Set(
    rows.map((r) => affiliationPairKey(r.individual_id, r.organization_id))
  );
}

// ── Co-occurrence (per-profile, read-time) ────────────────────────────────────

// The acting profile's observed clinician↔facility co-occurrences, from encounters
// naming BOTH a provider (attending) and a location_provider (facility) on one row,
// tagged with each side's registry type so the pure engine can enforce the
// individual↔organization invariant. Grouped by the id pair with a shared-visit count.
export function getCoOccurrences(profileId: number): CoOccurrence[] {
  const rows = db
    .prepare(
      `SELECT e.provider_id AS clinicianId, pc.type AS clinicianType,
              e.location_provider_id AS facilityId, pf.type AS facilityType,
              COUNT(*) AS sharedVisits
         FROM encounters e
         JOIN providers pc ON pc.id = e.provider_id
         JOIN providers pf ON pf.id = e.location_provider_id
        WHERE e.profile_id = ?
          AND e.provider_id IS NOT NULL
          AND e.location_provider_id IS NOT NULL
          AND e.provider_id <> e.location_provider_id
        GROUP BY e.provider_id, e.location_provider_id`
    )
    .all(profileId) as {
    clinicianId: number;
    clinicianType: ProviderType;
    facilityId: number;
    facilityType: ProviderType;
    sharedVisits: number;
  }[];
  return rows;
}

// One suggested affiliation, resolved to display names for the UI.
export interface AffiliationSuggestionView extends SuggestedAffiliation {
  individualName: string;
  organizationName: string;
}

// Suggested affiliations for the acting profile: co-occurrence minus any already
// linked/declined pair. Names resolved for the "link them?" prompt.
export function getSuggestedAffiliations(
  profileId: number
): AffiliationSuggestionView[] {
  const suggestions = suggestAffiliations(
    getCoOccurrences(profileId),
    affiliationKeysByStatus("linked"),
    affiliationKeysByStatus("declined")
  );
  return suggestions.map((s) => ({
    ...s,
    individualName: providerName(s.individualId),
    organizationName: providerName(s.organizationId),
  }));
}

function providerName(id: number): string {
  const row = db.prepare(`SELECT name FROM providers WHERE id = ?`).get(id) as
    { name: string } | undefined;
  return row?.name ?? `#${id}`;
}

// ── Write cores (global; the action gates on requireAdmin) ────────────────────

// Validate a manual/accepted pair is a genuine individual↔organization pairing, and
// return the canonical (individualId, organizationId) or null. Refuses a same-type
// pair (the schema shape) or a self-pair.
function canonicalPair(
  aId: number,
  bId: number
): { individualId: number; organizationId: number } | null {
  if (!aId || !bId || aId === bId) return null;
  const rows = db
    .prepare(`SELECT id, type FROM providers WHERE id IN (?, ?)`)
    .all(aId, bId) as { id: number; type: ProviderType }[];
  if (rows.length !== 2) return null;
  const individual = rows.find((r) => r.type === "individual");
  const org = rows.find((r) => r.type === "organization");
  if (!individual || !org) return null;
  return { individualId: individual.id, organizationId: org.id };
}

// Accept (link) an affiliation. Idempotent upsert to status='linked' on the pair.
// Returns true when a valid individual↔organization edge was written.
export function linkAffiliation(
  aId: number,
  bId: number,
  source: "manual" | "suggested" | "import" = "manual"
): boolean {
  const pair = canonicalPair(aId, bId);
  if (!pair) return false;
  writeTx(() => {
    db.prepare(
      `INSERT INTO provider_affiliations
         (individual_id, organization_id, status, source)
       VALUES (?,?, 'linked', ?)
       ON CONFLICT(individual_id, organization_id)
         DO UPDATE SET status = 'linked', source = excluded.source`
    ).run(pair.individualId, pair.organizationId, source);
  });
  return true;
}

// Decline a suggested affiliation: remembered on the stable pair key so it is never
// re-suggested. Idempotent upsert to status='declined'.
export function declineAffiliation(aId: number, bId: number): boolean {
  const pair = canonicalPair(aId, bId);
  if (!pair) return false;
  writeTx(() => {
    db.prepare(
      `INSERT INTO provider_affiliations
         (individual_id, organization_id, status, source)
       VALUES (?,?, 'declined', 'suggested')
       ON CONFLICT(individual_id, organization_id)
         DO UPDATE SET status = 'declined'`
    ).run(pair.individualId, pair.organizationId);
  });
  return true;
}

// Remove an affiliation edge entirely (un-link). Deletes the row so the pair can be
// re-suggested from co-occurrence; does NOT decline it.
export function unlinkAffiliation(aId: number, bId: number): boolean {
  const pair = canonicalPair(aId, bId);
  if (!pair) return false;
  const info = writeTx(() =>
    db
      .prepare(
        `DELETE FROM provider_affiliations
          WHERE individual_id = ? AND organization_id = ?`
      )
      .run(pair.individualId, pair.organizationId)
  );
  return info.changes > 0;
}

// ── Detail-page tie-ins ───────────────────────────────────────────────────────

export interface AffiliatedProviderRef {
  id: number;
  name: string;
  type: ProviderType;
  specialty: string | null;
}

// The linked counterparts of a provider (issue #1055 detail tie-ins). For an
// individual: the organizations they "Practice at". For an organization: its
// "People". Only status='linked' edges; archived counterparts still show (an
// affiliation is a durable fact — the archive disclosure is a directory concern).
export function getAffiliatesFor(
  providerId: number,
  providerType: ProviderType
): AffiliatedProviderRef[] {
  // Two LITERAL prepares (not a runtime-selected string) so the profile-scoping
  // source scanner can read each — both touch only GLOBAL tables (provider_affiliations
  // + providers), so neither needs a profile_id filter.
  if (providerType === "individual") {
    return db
      .prepare(
        `SELECT p.id, p.name, p.type, p.specialty
           FROM provider_affiliations a
           JOIN providers p ON p.id = a.organization_id
          WHERE a.individual_id = ? AND a.status = 'linked'
          ORDER BY p.name COLLATE NOCASE`
      )
      .all(providerId) as AffiliatedProviderRef[];
  }
  return db
    .prepare(
      `SELECT p.id, p.name, p.type, p.specialty
         FROM provider_affiliations a
         JOIN providers p ON p.id = a.individual_id
        WHERE a.organization_id = ? AND a.status = 'linked'
        ORDER BY p.name COLLATE NOCASE`
    )
    .all(providerId) as AffiliatedProviderRef[];
}

// ── Grouped, activity-aware directory index (issue #1055 part 2) ──────────────

export interface DirectoryProvider {
  id: number;
  name: string;
  type: ProviderType;
  npi: string | null;
  specialty: string | null;
  phone: string | null;
  address: string | null;
  archived: boolean;
  activity: number; // the acting profile's linked-record count
  lastActivity: string | null; // most recent activity date (per-profile)
  href: AppRoute;
}

export interface OrgGroup {
  org: DirectoryProvider;
  members: DirectoryProvider[];
}

export interface GroupedDirectory {
  orgs: OrgGroup[];
  unaffiliated: DirectoryProvider[]; // individuals with no linked org
  archivedCount: number;
  archived: DirectoryProvider[];
  hasEdges: boolean; // false ⇒ the caller may show a flat list instead
  flat: DirectoryProvider[]; // every non-archived provider, for search/fallback
}

// The acting profile's most-recent activity date for a provider, across the dated
// clinical tables — powers the recency sort/badge so a 2019 lab tech doesn't outrank
// the pediatrician. Profile-scoped; mirrors getProviderRelationship's union.
function lastActivityDate(
  profileId: number,
  providerId: number
): string | null {
  const row = db
    .prepare(
      `SELECT MAX(d) AS d FROM (
         SELECT date AS d FROM encounters
           WHERE profile_id = ? AND (provider_id = ? OR location_provider_id = ?)
         UNION ALL
         SELECT date AS d FROM procedures WHERE profile_id = ? AND provider_id = ?
         UNION ALL
         SELECT date AS d FROM medical_records WHERE profile_id = ? AND provider_id = ?
         UNION ALL
         SELECT date AS d FROM immunizations WHERE profile_id = ? AND provider_id = ?
         UNION ALL
         SELECT scheduled_at AS d FROM appointments WHERE profile_id = ? AND provider_id = ?
       )`
    )
    .get(
      profileId,
      providerId,
      providerId,
      profileId,
      providerId,
      profileId,
      providerId,
      profileId,
      providerId,
      profileId,
      providerId
    ) as { d: string | null };
  return row.d;
}

function toDirectoryProvider(
  profileId: number,
  p: {
    id: number;
    name: string;
    type: ProviderType;
    npi: string | null;
    specialty: string | null;
    phone: string | null;
    address: string | null;
    archived: number;
  }
): DirectoryProvider {
  return {
    id: p.id,
    name: p.name,
    type: p.type,
    npi: p.npi,
    specialty: p.specialty,
    phone: p.phone,
    address: p.address,
    archived: p.archived === 1,
    activity: getProviderActivityTotal(profileId, p.id),
    lastActivity: lastActivityDate(profileId, p.id),
    href: `/providers/${p.id}` as AppRoute,
  };
}

// Newest activity first (nulls last), then name — the recency-first default.
function byRecency(a: DirectoryProvider, b: DirectoryProvider): number {
  const av = a.lastActivity ?? "";
  const bv = b.lastActivity ?? "";
  if (av !== bv) return av < bv ? 1 : -1;
  return a.name.localeCompare(b.name);
}

// Build the grouped, activity-aware directory (issue #1055): organizations as cards
// with their linked individuals nested, unaffiliated individuals in their own
// section, archived providers behind a disclosure, and a flat list for search /
// no-edges fallback. The registry is global; only the activity counts/dates are the
// acting profile's.
export function getGroupedProviderDirectory(
  profileId: number
): GroupedDirectory {
  const rows = db
    .prepare(
      `SELECT id, name, type, npi, specialty, phone, address, archived
         FROM providers ORDER BY name COLLATE NOCASE`
    )
    .all() as {
    id: number;
    name: string;
    type: ProviderType;
    npi: string | null;
    specialty: string | null;
    phone: string | null;
    address: string | null;
    archived: number;
  }[];
  const all = rows.map((r) => toDirectoryProvider(profileId, r));
  const byId = new Map(all.map((p) => [p.id, p]));

  const edges = db
    .prepare(
      `SELECT individual_id, organization_id FROM provider_affiliations
        WHERE status = 'linked'`
    )
    .all() as { individual_id: number; organization_id: number }[];
  const hasEdges = edges.length > 0;

  // Which individuals are affiliated with which orgs (non-archived counterparts
  // are what the directory groups; an archived provider is shown only in the
  // disclosure regardless of edges).
  const membersByOrg = new Map<number, DirectoryProvider[]>();
  const affiliatedIndividuals = new Set<number>();
  for (const e of edges) {
    const indiv = byId.get(e.individual_id);
    const org = byId.get(e.organization_id);
    if (!indiv || !org) continue;
    affiliatedIndividuals.add(e.individual_id);
    if (org.archived || indiv.archived) continue;
    const list = membersByOrg.get(e.organization_id) ?? [];
    if (!list.some((m) => m.id === indiv.id)) list.push(indiv);
    membersByOrg.set(e.organization_id, list);
  }

  const active = all.filter((p) => !p.archived);
  const orgs: OrgGroup[] = active
    .filter((p) => p.type === "organization")
    .map((org) => ({
      org,
      members: (membersByOrg.get(org.id) ?? []).slice().sort(byRecency),
    }))
    .sort((a, b) => {
      // Sort an org card by the most recent activity of the org OR any member.
      const amax = [a.org, ...a.members].reduce<string>(
        (m, p) => (p.lastActivity && p.lastActivity > m ? p.lastActivity : m),
        ""
      );
      const bmax = [b.org, ...b.members].reduce<string>(
        (m, p) => (p.lastActivity && p.lastActivity > m ? p.lastActivity : m),
        ""
      );
      if (amax !== bmax) return amax < bmax ? 1 : -1;
      return a.org.name.localeCompare(b.org.name);
    });

  const unaffiliated = active
    .filter((p) => p.type === "individual" && !affiliatedIndividuals.has(p.id))
    .sort(byRecency);

  const archived = all.filter((p) => p.archived).sort(byRecency);

  return {
    orgs,
    unaffiliated,
    archivedCount: archived.length,
    archived,
    hasEdges,
    flat: active.slice().sort(byRecency),
  };
}
