import { db, writeTx } from "../db";
import { ENCOUNTER_REPRESENTATIVE_IDS } from "./medical";
import {
  type LinkableEncounter,
  type LinkableRecord,
  type RecordVisitSuggestion,
  type EncounterFromVisit,
  type EpisodeRange,
  type EpisodeVisitSuggestion,
  type VisitLinkDomain,
  stableToken,
  episodeToken,
  visitLinkSignature,
  suggestForRecord,
  suggestForEncounter,
  suggestForEpisode,
} from "../visit-link-suggest";

// The DB read/derive + decision-persistence layer for record ↔ visit and episode ↔
// visit linking (#1050/#1053). The tier-2 suggestion MATH is the pure engine
// (lib/visit-link-suggest.ts); this module gathers the current rows, derives
// suggestions at READ time (nothing stored but the accept/decline decision), and
// applies an accepted link by setting the row's encounter_id. Every statement is
// profile-scoped (profile-scoping rule); the write core is auth-blind (the actions
// gate).

// Record-domain → { table, date column, provider column, label expr, extra filter }.
// `episode` and the bare 'record' family are handled separately. medical_records is
// tier-2-scoped to prescription category (the "prescribed at this visit" framing,
// #1050) — labs/vitals still get a deterministic tier-1 link when the FHIR source
// carried the encounter reference, they're just not heuristically suggested.
interface DomainConfig {
  table: string;
  dateExpr: string;
  providerExpr: string;
  labelExpr: string;
  // The SQL expression for the row's stable external_id. intake_items has NO
  // external_id column (meds dedup by document_id + source), so its token is always
  // id-based; a manual med's id is stable, and an imported med's link is tier-1
  // re-derived, so it never needs a stable external_id.
  externalIdExpr: string;
  extra?: string;
}

const RECORD_DOMAINS: Record<
  Exclude<VisitLinkDomain, "episode">,
  DomainConfig
> = {
  record: {
    table: "medical_records",
    dateExpr: "t.date",
    providerExpr: "t.provider_id",
    labelExpr: "t.name",
    externalIdExpr: "t.external_id",
    extra: "t.category = 'prescription'",
  },
  medication: {
    table: "intake_items",
    dateExpr:
      "(SELECT MIN(mc.started_on) FROM medication_courses mc WHERE mc.item_id = t.id)",
    providerExpr: "t.provider_id",
    labelExpr: "t.name",
    externalIdExpr: "NULL",
    extra: "t.kind = 'medication'",
  },
  condition: {
    table: "conditions",
    dateExpr: "t.onset_date",
    providerExpr: "NULL",
    labelExpr: "t.name",
    externalIdExpr: "t.external_id",
  },
  procedure: {
    table: "procedures",
    dateExpr: "t.date",
    providerExpr: "t.provider_id",
    labelExpr: "t.name",
    externalIdExpr: "t.external_id",
  },
  imaging: {
    table: "imaging_studies",
    dateExpr: "t.study_date",
    providerExpr: "COALESCE(t.ordering_provider_id, t.reading_provider_id)",
    labelExpr: "COALESCE(t.body_region, t.modality)",
    externalIdExpr: "t.external_id",
  },
  immunization: {
    table: "immunizations",
    dateExpr: "t.date",
    providerExpr: "t.provider_id",
    labelExpr: "t.vaccine",
    externalIdExpr: "t.external_id",
  },
};

const RECORD_DOMAIN_LIST = Object.keys(RECORD_DOMAINS) as Exclude<
  VisitLinkDomain,
  "episode"
>[];

function domainTable(domain: VisitLinkDomain): string {
  if (domain === "episode") return "illness_episodes";
  return RECORD_DOMAINS[domain].table;
}

// ── Reading the linkable universe ────────────────────────────────────────────────

// The profile's deduped visit history as Linkable shapes (representative row per
// visit, so a cross-document duplicate visit is offered once).
export function getLinkableEncounters(profileId: number): LinkableEncounter[] {
  return db
    .prepare(
      `SELECT e.id, e.external_id, e.date,
              e.provider_id AS providerId,
              e.location_provider_id AS locationProviderId
         FROM encounters e
        WHERE e.profile_id = ? AND e.id IN (${ENCOUNTER_REPRESENTATIVE_IDS})
        ORDER BY e.date DESC, e.id DESC`
    )
    .all(profileId, profileId) as LinkableEncounter[];
}

// Every UNLINKED, dated, visit-anchored record across the tier-2 domains. Bounded by
// the count of not-yet-linked records; feeds the read-time suggestion engine.
export function getUnlinkedRecords(profileId: number): LinkableRecord[] {
  const out: LinkableRecord[] = [];
  for (const domain of RECORD_DOMAIN_LIST) {
    const c = RECORD_DOMAINS[domain];
    const rows = db
      .prepare(
        `SELECT t.id, ${c.externalIdExpr} AS external_id,
                ${c.dateExpr} AS date,
                ${c.providerExpr} AS providerId,
                ${c.labelExpr} AS label
           FROM ${c.table} t
          WHERE t.profile_id = ? AND t.encounter_id IS NULL
                AND ${c.dateExpr} IS NOT NULL
                ${c.extra ? `AND ${c.extra}` : ""}`
      )
      .all(profileId) as Omit<LinkableRecord, "domain">[];
    for (const r of rows) out.push({ ...r, domain });
  }
  return out;
}

// One unlinked record as a Linkable shape (for a record detail page's inverse
// suggestion). Null when the row is missing, linked, or undated.
function getUnlinkedRecord(
  profileId: number,
  domain: Exclude<VisitLinkDomain, "episode">,
  id: number
): LinkableRecord | null {
  const c = RECORD_DOMAINS[domain];
  const row = db
    .prepare(
      `SELECT t.id, ${c.externalIdExpr} AS external_id,
              ${c.dateExpr} AS date,
              ${c.providerExpr} AS providerId,
              ${c.labelExpr} AS label
         FROM ${c.table} t
        WHERE t.profile_id = ? AND t.id = ? AND t.encounter_id IS NULL
              AND ${c.dateExpr} IS NOT NULL
              ${c.extra ? `AND ${c.extra}` : ""}`
    )
    .get(profileId, id) as Omit<LinkableRecord, "domain"> | undefined;
  return row ? { ...row, domain } : null;
}

// ── Decisions (durable, stable-key) ──────────────────────────────────────────────

// The declined (encounter, target) signatures for a profile, so a declined pair is
// never re-suggested. `linked` decisions do not filter suggestions (a linked row is
// excluded by its encounter_id already), they exist for reprocess durability.
export function getDeclinedSignatures(profileId: number): Set<string> {
  const rows = db
    .prepare(
      `SELECT encounter_key, target_key
         FROM visit_link_decisions
        WHERE profile_id = ? AND decision = 'declined'`
    )
    .all(profileId) as { encounter_key: string; target_key: string }[];
  return new Set(
    rows.map((r) => visitLinkSignature(r.encounter_key, r.target_key))
  );
}

function upsertDecision(
  profileId: number,
  domain: VisitLinkDomain,
  encounterKey: string,
  targetKey: string,
  decision: "linked" | "declined"
): void {
  db.prepare(
    `INSERT INTO visit_link_decisions
       (profile_id, domain, encounter_key, target_key, decision)
     VALUES (?,?,?,?,?)
     ON CONFLICT(profile_id, domain, encounter_key, target_key)
       DO UPDATE SET decision = excluded.decision, created_at = datetime('now')`
  ).run(profileId, domain, encounterKey, targetKey, decision);
}

// Resolve a stable token ('ext:<external_id>' | 'id:<n>') to a live row id in `table`
// for this profile, or null if it no longer exists (a dead decision row).
function resolveToken(
  profileId: number,
  table: string,
  token: string
): number | null {
  if (token.startsWith("id:")) {
    const id = Number(token.slice(3));
    const row = db
      .prepare(`SELECT id FROM ${table} WHERE id = ? AND profile_id = ?`)
      .get(id, profileId) as { id: number } | undefined;
    return row ? row.id : null;
  }
  if (token.startsWith("ext:")) {
    // intake_items carries no external_id column, so an ext token can never name a
    // medication row — guard so the lookup doesn't hit a missing column.
    if (table === "intake_items") return null;
    const ext = token.slice(4);
    const row = db
      .prepare(
        `SELECT id FROM ${table} WHERE external_id = ? AND profile_id = ?`
      )
      .get(ext, profileId) as { id: number } | undefined;
    return row ? row.id : null;
  }
  return null;
}

function encounterTokenById(
  profileId: number,
  encounterId: number
): string | null {
  const row = db
    .prepare(
      `SELECT id, external_id FROM encounters WHERE id = ? AND profile_id = ?`
    )
    .get(encounterId, profileId) as
    { id: number; external_id: string | null } | undefined;
  return row ? stableToken(row) : null;
}

function recordTokenById(
  profileId: number,
  domain: Exclude<VisitLinkDomain, "episode">,
  id: number
): string | null {
  const c = RECORD_DOMAINS[domain];
  const row = db
    .prepare(
      `SELECT t.id, ${c.externalIdExpr} AS external_id
         FROM ${c.table} t WHERE t.id = ? AND t.profile_id = ?`
    )
    .get(id, profileId) as
    { id: number; external_id: string | null } | undefined;
  return row ? stableToken(row) : null;
}

// ── Applying / declining / manual link (record ↔ visit) ─────────────────────────

// Accept a suggested (or manual) record↔visit link: set encounter_id AND record a
// durable 'linked' decision keyed on the two stable tokens, so a reprocess of the
// imported row re-applies it. Verifies both rows belong to the profile. Returns true
// when the link was set.
export function linkRecordToEncounter(
  profileId: number,
  domain: Exclude<VisitLinkDomain, "episode">,
  recordId: number,
  encounterId: number
): boolean {
  return writeTx(() => {
    const encToken = encounterTokenById(profileId, encounterId);
    const recToken = recordTokenById(profileId, domain, recordId);
    if (!encToken || !recToken) return false;
    const table = RECORD_DOMAINS[domain].table;
    const info = db
      .prepare(
        `UPDATE ${table} SET encounter_id = ? WHERE id = ? AND profile_id = ?`
      )
      .run(encounterId, recordId, profileId);
    if (info.changes === 0) return false;
    upsertDecision(profileId, domain, encToken, recToken, "linked");
    return true;
  });
}

// Decline a suggested record↔visit pair: remembered so it is never re-suggested.
export function declineRecordVisitLink(
  profileId: number,
  domain: Exclude<VisitLinkDomain, "episode">,
  recordId: number,
  encounterId: number
): boolean {
  return writeTx(() => {
    const encToken = encounterTokenById(profileId, encounterId);
    const recToken = recordTokenById(profileId, domain, recordId);
    if (!encToken || !recToken) return false;
    upsertDecision(profileId, domain, encToken, recToken, "declined");
    return true;
  });
}

// Clear a record's visit link (un-link). Removes the encounter_id and the linked
// decision so the pair can be re-suggested; does NOT decline it.
export function unlinkRecordFromEncounter(
  profileId: number,
  domain: Exclude<VisitLinkDomain, "episode">,
  recordId: number
): boolean {
  return writeTx(() => {
    const recToken = recordTokenById(profileId, domain, recordId);
    const table = RECORD_DOMAINS[domain].table;
    const info = db
      .prepare(
        `UPDATE ${table} SET encounter_id = NULL WHERE id = ? AND profile_id = ?`
      )
      .run(recordId, profileId);
    if (recToken) {
      db.prepare(
        `DELETE FROM visit_link_decisions
          WHERE profile_id = ? AND domain = ? AND target_key = ? AND decision = 'linked'`
      ).run(profileId, domain, recToken);
    }
    return info.changes > 0;
  });
}

// ── Read-time suggestions ────────────────────────────────────────────────────────

// "From this visit?" — the records that resolve UNIQUELY to this one encounter
// (strong or medium), for the encounter detail block's batch accept.
export function suggestionsForEncounter(
  profileId: number,
  encounterId: number
): EncounterFromVisit {
  const enc = db
    .prepare(
      `SELECT e.id, e.external_id, e.date,
              e.provider_id AS providerId,
              e.location_provider_id AS locationProviderId
         FROM encounters e WHERE e.id = ? AND e.profile_id = ?`
    )
    .get(encounterId, profileId) as LinkableEncounter | undefined;
  if (!enc) return { suggestions: [] } as EncounterFromVisit;
  const records = getUnlinkedRecords(profileId);
  const declined = getDeclinedSignatures(profileId);
  return suggestForEncounter(enc, records, declined);
}

// The inverse single-row suggestion for a record detail page.
export function suggestionForRecord(
  profileId: number,
  domain: Exclude<VisitLinkDomain, "episode">,
  id: number
): RecordVisitSuggestion | null {
  const rec = getUnlinkedRecord(profileId, domain, id);
  if (!rec) return null;
  const encounters = getLinkableEncounters(profileId);
  const declined = getDeclinedSignatures(profileId);
  return suggestForRecord(rec, encounters, declined);
}

// The linked encounter for a record ("Prescribed at: …"), or null.
export interface LinkedEncounterRef {
  id: number;
  date: string;
  type: string | null;
  providerName: string | null;
}

export function encounterForRecord(
  profileId: number,
  domain: Exclude<VisitLinkDomain, "episode">,
  id: number
): LinkedEncounterRef | null {
  const table = RECORD_DOMAINS[domain].table;
  return (
    (db
      .prepare(
        `SELECT e.id, e.date, e.type, p.name AS providerName
           FROM ${table} t
           JOIN encounters e ON e.id = t.encounter_id AND e.profile_id = t.profile_id
           LEFT JOIN providers p ON p.id = e.provider_id
          WHERE t.id = ? AND t.profile_id = ?`
      )
      .get(id, profileId) as LinkedEncounterRef | undefined) ?? null
  );
}

// The "From this visit" section: rows already linked to this encounter, grouped by
// kind, for the encounter detail page.
export interface VisitLinkedRow {
  domain: Exclude<VisitLinkDomain, "episode">;
  id: number;
  label: string;
  date: string | null;
}

export function linkedRowsForEncounter(
  profileId: number,
  encounterId: number
): VisitLinkedRow[] {
  const out: VisitLinkedRow[] = [];
  for (const domain of RECORD_DOMAIN_LIST) {
    const c = RECORD_DOMAINS[domain];
    const rows = db
      .prepare(
        `SELECT t.id, ${c.labelExpr} AS label, ${c.dateExpr} AS date
           FROM ${c.table} t
          WHERE t.profile_id = ? AND t.encounter_id = ?
                ${c.extra ? `AND ${c.extra}` : ""}
          ORDER BY t.id`
      )
      .all(profileId, encounterId) as {
      id: number;
      label: string;
      date: string | null;
    }[];
    for (const r of rows) out.push({ domain, ...r });
  }
  return out;
}

// ── Episode ↔ visit (#1053) ─────────────────────────────────────────────────────

export function suggestionForEpisode(
  profileId: number,
  episode: EpisodeRange
): EpisodeVisitSuggestion | null {
  const encounters = getLinkableEncounters(profileId);
  const declined = getDeclinedSignatures(profileId);
  return suggestForEpisode(episode, encounters, declined);
}

// The visit an episode is linked to (for the cockpit "Care" line).
export function encounterForEpisode(
  profileId: number,
  episodeId: number
): LinkedEncounterRef | null {
  return (
    (db
      .prepare(
        `SELECT e.id, e.date, e.type, p.name AS providerName
           FROM illness_episodes ie
           JOIN encounters e ON e.id = ie.encounter_id AND e.profile_id = ie.profile_id
           LEFT JOIN providers p ON p.id = e.provider_id
          WHERE ie.id = ? AND ie.profile_id = ?`
      )
      .get(episodeId, profileId) as LinkedEncounterRef | undefined) ?? null
  );
}

// The episode an encounter falls in, when the encounter is linked to one — for the
// encounter page's "During illness episode: …, day N" back-link. day N is computed
// by the caller from the episode range.
export interface EncounterEpisodeRef {
  id: number;
  situation: string;
  started_at: string | null;
}

export function episodeForLinkedEncounter(
  profileId: number,
  encounterId: number
): EncounterEpisodeRef | null {
  return (
    (db
      .prepare(
        `SELECT ie.id, ie.situation, ie.started_at
           FROM illness_episodes ie
          WHERE ie.encounter_id = ? AND ie.profile_id = ?
          ORDER BY ie.id DESC LIMIT 1`
      )
      .get(encounterId, profileId) as EncounterEpisodeRef | undefined) ?? null
  );
}

export function linkEpisodeToEncounter(
  profileId: number,
  episodeId: number,
  encounterId: number
): boolean {
  return writeTx(() => {
    const encToken = encounterTokenById(profileId, encounterId);
    if (!encToken) return false;
    const info = db
      .prepare(
        `UPDATE illness_episodes SET encounter_id = ?
          WHERE id = ? AND profile_id = ?`
      )
      .run(encounterId, episodeId, profileId);
    if (info.changes === 0) return false;
    upsertDecision(
      profileId,
      "episode",
      encToken,
      episodeToken({ id: episodeId }),
      "linked"
    );
    return true;
  });
}

export function declineEpisodeVisitLink(
  profileId: number,
  episodeId: number,
  encounterId: number
): boolean {
  return writeTx(() => {
    const encToken = encounterTokenById(profileId, encounterId);
    if (!encToken) return false;
    upsertDecision(
      profileId,
      "episode",
      encToken,
      episodeToken({ id: episodeId }),
      "declined"
    );
    return true;
  });
}

export function unlinkEpisodeFromEncounter(
  profileId: number,
  episodeId: number
): boolean {
  return writeTx(() => {
    const info = db
      .prepare(
        `UPDATE illness_episodes SET encounter_id = NULL
          WHERE id = ? AND profile_id = ?`
      )
      .run(episodeId, profileId);
    db.prepare(
      `DELETE FROM visit_link_decisions
        WHERE profile_id = ? AND domain = 'episode' AND target_key = ? AND decision = 'linked'`
    ).run(profileId, episodeToken({ id: episodeId }));
    return info.changes > 0;
  });
}

// ── Reprocess durability + row-ops side-state ────────────────────────────────────

// Re-apply every durable 'linked' decision whose BOTH sides still resolve, setting
// the row's encounter_id — called after a document reprocess (delete-and-reinsert)
// re-creates imported rows under new ids but the SAME external_ids (#1050). Tier-1
// FHIR links self-heal separately at persist; this restores the tier-2 accepted
// links. Opportunistically SWEEPS a decision whose either side no longer exists (a
// dead row, #203). Idempotent.
export function reapplyVisitLinkDecisions(profileId: number): void {
  const rows = db
    .prepare(
      `SELECT id, domain, encounter_key, target_key, decision
         FROM visit_link_decisions WHERE profile_id = ?`
    )
    .all(profileId) as {
    id: number;
    domain: VisitLinkDomain;
    encounter_key: string;
    target_key: string;
    decision: "linked" | "declined";
  }[];
  for (const d of rows) {
    const encId = resolveToken(profileId, "encounters", d.encounter_key);
    const targetTable = domainTable(d.domain);
    const targetId = resolveToken(profileId, targetTable, d.target_key);
    // Sweep a dead decision (either side gone). Names/ids don't meaningfully
    // recycle here, so a resolvable-once-gone token is truly orphaned.
    if (encId == null || targetId == null) {
      db.prepare(
        `DELETE FROM visit_link_decisions WHERE id = ? AND profile_id = ?`
      ).run(d.id, profileId);
      continue;
    }
    if (d.decision === "linked") {
      db.prepare(
        `UPDATE ${targetTable} SET encounter_id = ?
          WHERE id = ? AND profile_id = ? AND encounter_id IS NULL`
      ).run(encId, targetId, profileId);
    }
  }
}

// NULL every record/episode back-link to an encounter about to be deleted (the
// row-ops convention — encounter_id carries no ON DELETE, so the FK would otherwise
// block the delete). Called by deleteEncounter and by the import delete/reprocess
// clear. Also sweeps the encounter's decision rows. `encounterExternalId` is passed
// so the decision sweep can match `ext:` tokens too (the encounter row is gone by the
// time a later reapply would run).
export function nullEncounterLinks(
  profileId: number,
  encounterId: number
): void {
  for (const domain of RECORD_DOMAIN_LIST) {
    const table = RECORD_DOMAINS[domain].table;
    db.prepare(
      `UPDATE ${table} SET encounter_id = NULL
        WHERE encounter_id = ? AND profile_id = ?`
    ).run(encounterId, profileId);
  }
  db.prepare(
    `UPDATE illness_episodes SET encounter_id = NULL
      WHERE encounter_id = ? AND profile_id = ?`
  ).run(encounterId, profileId);
}
