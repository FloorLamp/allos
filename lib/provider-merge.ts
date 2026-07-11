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
  { table: "encounters", column: "provider_id" },
  { table: "encounters", column: "location_provider_id" },
  { table: "procedures", column: "provider_id" },
  { table: "care_plan_items", column: "provider_id" },
  { table: "appointments", column: "provider_id" },
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
