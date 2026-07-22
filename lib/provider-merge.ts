// Pure logic for the provider duplicate-merge feature (issue #275). No DB/network
// — the DB layer (lib/providers-db) consumes PROVIDER_LINK_COLUMNS to re-point
// every provider link in one transaction, and the pages format the impact summary
// through here. Split out so the merge plan and its count summary are unit-tested.
//
// WHY a bound list (the #201 lesson): providers are referenced from SEVEN owned
// tables via a nullable provider_id (plus encounters' second location_provider_id)
// link. A merge that forgot even one column would strand rows pointing at the
// deleted duplicate — an FK-dangling leak. So the full set lives HERE as the ONE
// source of truth, and lib/__tests__/provider-merge.test.ts binds it against the
// schema (every column named provider_id / location_provider_id in a CREATE TABLE)
// so a future provider link CANNOT be added without landing in this list.

import type { Provider } from "./types";

// Composite display label that keeps two same-named providers apart in the merge
// picker and the IRREVERSIBLE confirm (issue #532). The merge exists FOR the
// duplicate-name case, yet a name-only label renders two "Quest Diagnostics" rows
// byte-identically — so the admin picks blind, and the destructive "deletes X, keeps
// Y" confirm names both sides with the same string. Returns the bare name when it's
// unique among `all`; otherwise appends the FIRST field that actually differs across
// the same-named group — type, then npi/identifier, then address, then phone — with
// the id as a guaranteed-distinguishing fallback. Pure + unit-tested; the picker
// option and the confirm copy consume it so they can't drift.
const DISAMBIG_FIELDS = [
  "type",
  "npi",
  "identifier",
  "address",
  "phone",
] as const;

function disambigFieldValue(p: Provider, field: string): string | null {
  switch (field) {
    case "type":
      return p.type === "individual" ? "Individual" : "Organization";
    case "npi":
      return p.npi ? `NPI ${p.npi}` : null;
    case "identifier":
      return p.identifier ?? null;
    case "address":
      return p.address ?? null;
    case "phone":
      return p.phone ?? null;
    default:
      return null;
  }
}

export function providerDisambigLabel(
  p: Provider,
  all: readonly Provider[]
): string {
  const norm = (s: string) => s.replace(/\s+/g, " ").trim().toLowerCase();
  const group = all.filter((o) => norm(o.name) === norm(p.name));
  if (group.length <= 1) return p.name;
  for (const field of DISAMBIG_FIELDS) {
    const mine = disambigFieldValue(p, field);
    if (mine == null) continue;
    // Only useful if it separates p from at least one same-named peer.
    const distinguishes = group.some(
      (o) => o.id !== p.id && disambigFieldValue(o, field) !== mine
    );
    if (distinguishes) return `${p.name} · ${mine}`;
  }
  return `${p.name} · #${p.id}`;
}

export interface ProviderLink {
  table: string;
  column: string;
}

// Every (owned table, provider-link column) pair. The merge re-points each one
// from the absorbed row to the survivor; the schema-binding test keeps it complete.
export const PROVIDER_LINK_COLUMNS: ProviderLink[] = [
  { table: "medical_records", column: "provider_id" },
  { table: "immunizations", column: "provider_id" },
  { table: "intake_items", column: "provider_id" },
  // Per-course prescriber link (#1204): a renewal course records the individual who
  // prescribed it. A GLOBAL re-point (no profile scope) like every other link here.
  { table: "medication_courses", column: "provider_id" },
  { table: "encounters", column: "provider_id" },
  { table: "encounters", column: "location_provider_id" },
  { table: "procedures", column: "provider_id" },
  { table: "care_plan_items", column: "provider_id" },
  { table: "appointments", column: "provider_id" },
  // Imaging studies (#702) link both the ordering and the reading (radiologist)
  // provider — like encounters' two provider columns, so a merge re-points both.
  { table: "imaging_studies", column: "ordering_provider_id" },
  { table: "imaging_studies", column: "reading_provider_id" },
  // Dental procedures (#705) link the performing/recording dentist, so a merge
  // re-points them like the other clinical domains.
  { table: "dental_procedures", column: "provider_id" },
  // Optical prescriptions (#697) link the prescribing optometrist.
  { table: "optical_prescriptions", column: "provider_id" },
  // Skin lesions (#715) link the recording dermatologist.
  { table: "skin_lesions", column: "provider_id" },
];

// The link columns grouped by table (a table may carry more than one — encounters
// links both attending provider_id and facility location_provider_id). Used to
// count DISTINCT touched rows per table (a visit that names the same provider in
// both columns is one visit, not two) and to iterate tables for the impact read.
export function providerLinkTables(): { table: string; columns: string[] }[] {
  const byTable = new Map<string, string[]>();
  for (const { table, column } of PROVIDER_LINK_COLUMNS) {
    const cols = byTable.get(table) ?? [];
    cols.push(column);
    byTable.set(table, cols);
  }
  return [...byTable.entries()].map(([table, columns]) => ({ table, columns }));
}

export type MergePlan =
  { ok: true; operations: ProviderLink[] } | { ok: false; reason: string };

// Validate a merge request and return the re-point operations (the full bound
// list) when it's sound. Pure: rejects a self-merge and non-positive ids; the
// existence of both rows is checked at the DB boundary (lib/providers-db).
export function planProviderMerge(
  survivorId: number,
  duplicateId: number
): MergePlan {
  if (!Number.isInteger(survivorId) || survivorId <= 0)
    return { ok: false, reason: "Invalid survivor provider." };
  if (!Number.isInteger(duplicateId) || duplicateId <= 0)
    return { ok: false, reason: "Invalid duplicate provider." };
  if (survivorId === duplicateId)
    return { ok: false, reason: "Pick two different providers to merge." };
  return { ok: true, operations: PROVIDER_LINK_COLUMNS };
}

// Per-table touched-row counts for the confirm dialog. `profiles` is the number
// of DISTINCT profiles whose rows point at the absorbed provider — surfaced as a
// COUNT ONLY (the issue's count-only confirm: "14 records, 3 visits across 2
// profiles"), never any cross-profile record detail.
export interface ProviderMergeImpact {
  perTable: { table: string; count: number }[];
  profiles: number;
  total: number;
}

// Friendly bucket label for a linked table, used in the count-only summary.
const TABLE_LABEL: Record<string, [singular: string, plural: string]> = {
  medical_records: ["record", "records"],
  encounters: ["visit", "visits"],
  intake_items: ["medication", "medications"],
  immunizations: ["immunization", "immunizations"],
  procedures: ["procedure", "procedures"],
  care_plan_items: ["care-plan item", "care-plan items"],
  appointments: ["appointment", "appointments"],
  imaging_studies: ["imaging study", "imaging studies"],
  optical_prescriptions: ["optical prescription", "optical prescriptions"],
};

function plural(table: string, count: number): string {
  const pair = TABLE_LABEL[table];
  const word = pair ? (count === 1 ? pair[0] : pair[1]) : table;
  return `${count} ${word}`;
}

// Build the count-only human summary shown in the merge confirm dialog, e.g.
// "14 records · 3 visits · 2 medications across 2 profiles". Returns null when
// nothing links the absorbed provider (a clean, detail-free absorb). Pure so the
// dialog and its test share one wording.
export function formatMergeImpact(impact: ProviderMergeImpact): string | null {
  const parts = impact.perTable
    .filter((t) => t.count > 0)
    .map((t) => plural(t.table, t.count));
  if (parts.length === 0) return null;
  const across =
    impact.profiles === 1 ? "1 profile" : `${impact.profiles} profiles`;
  return `${parts.join(" · ")} across ${across}`;
}

// The audit-log `detail` string for a provider merge (issue #655). The absorbed row
// is DELETED by the merge and integer ids never recycle, so the audit event is the
// only surviving record of what happened — it must carry the absorbed provider's id
// AND name (otherwise unrecoverable), the surviving id, and the per-table re-point
// counts. Identifiers/counts only, never medical content (the audit-log PHI rule).
// Pure so the action and its test share one wording; the recordAudit backstop caps
// length, but this stays compact.
export function formatProviderMergeAudit(args: {
  survivorId: number;
  absorbedId: number;
  absorbedName: string;
  impact: ProviderMergeImpact;
}): string {
  const counts = args.impact.perTable
    .filter((t) => t.count > 0)
    .map((t) => plural(t.table, t.count))
    .join(", ");
  const base = `absorbed #${args.absorbedId} "${args.absorbedName}" into #${args.survivorId}`;
  return counts ? `${base}; re-pointed ${counts}` : base;
}
