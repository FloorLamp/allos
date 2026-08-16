import { describe, expect, it } from "vitest";
import {
  PROVIDER_LINK_COLUMNS,
  providerLinkTables,
  planProviderMerge,
  formatMergeImpact,
  formatProviderMergeAudit,
  providerDisambigLabel,
  type ProviderMergeImpact,
} from "@/lib/provider-merge";
import type { Provider } from "@/lib/types";
import {
  createdTables,
  finalTableName,
  migrationSources,
  tableRenames,
  tablesRetired,
} from "./migration-schema-scan";

function provider(
  p: Partial<Provider> & { id: number; name: string }
): Provider {
  return {
    type: "organization",
    npi: null,
    identifier: null,
    phone: null,
    address: null,
    specialty_code: null,
    specialty: null,
    archived: 0,
    contact_edited: 0,
    created_at: "2020-01-01",
    ...p,
  };
}

describe("providerDisambigLabel (issue #532)", () => {
  it("returns the bare name when it's unique among the set", () => {
    const a = provider({ id: 1, name: "Quest Diagnostics" });
    const b = provider({ id: 2, name: "LabCorp" });
    expect(providerDisambigLabel(a, [a, b])).toBe("Quest Diagnostics");
  });

  it("appends the first differing field for two same-named rows", () => {
    // Same name + type, distinct NPIs → labels split on NPI, the strongest signal.
    const a = provider({
      id: 1,
      name: "Quest Diagnostics",
      npi: "1000000010",
    });
    const b = provider({
      id: 2,
      name: "Quest Diagnostics",
      npi: "1000000011",
    });
    expect(providerDisambigLabel(a, [a, b])).toBe(
      "Quest Diagnostics · NPI 1000000010"
    );
    expect(providerDisambigLabel(b, [a, b])).toBe(
      "Quest Diagnostics · NPI 1000000011"
    );
  });

  it("prefers type, then falls to a later field when type matches", () => {
    // An org and an individual sharing a name split on type.
    const org = provider({ id: 1, name: "Dr. Smith", type: "organization" });
    const ind = provider({ id: 2, name: "Dr. Smith", type: "individual" });
    expect(providerDisambigLabel(org, [org, ind])).toBe(
      "Dr. Smith · Organization"
    );
    // Two same-name same-type rows with only an address difference split on it.
    const cityA = provider({
      id: 3,
      name: "City Medical",
      address: "1 Alpha St, Springfield",
    });
    const cityB = provider({
      id: 4,
      name: "City Medical",
      address: "2 Beta Ave, Portland",
    });
    expect(providerDisambigLabel(cityA, [cityA, cityB])).toBe(
      "City Medical · 1 Alpha St, Springfield"
    );
  });

  it("falls back to the id when no field distinguishes the pair", () => {
    // Two rows identical on every disambig field (distinct only by id) — the id
    // is the guaranteed-distinguishing last resort.
    const a = provider({ id: 7, name: "Same Row" });
    const b = provider({ id: 8, name: "Same Row" });
    expect(providerDisambigLabel(a, [a, b])).toBe("Same Row · #7");
    expect(providerDisambigLabel(b, [a, b])).toBe("Same Row · #8");
  });
});

describe("planProviderMerge", () => {
  it("rejects a self-merge", () => {
    expect(planProviderMerge(5, 5)).toEqual({
      ok: false,
      reason: "Pick two different providers to merge.",
    });
  });

  it("rejects non-positive ids", () => {
    expect(planProviderMerge(0, 3).ok).toBe(false);
    expect(planProviderMerge(3, -1).ok).toBe(false);
    expect(planProviderMerge(1.5, 3).ok).toBe(false);
  });

  it("returns the full re-point operation set for a valid merge", () => {
    const plan = planProviderMerge(1, 2);
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.operations).toBe(PROVIDER_LINK_COLUMNS);
  });
});

describe("providerLinkTables groups columns by table", () => {
  it("collapses encounters' two provider columns into one entry", () => {
    const enc = providerLinkTables().find((t) => t.table === "encounters");
    expect(enc?.columns.sort()).toEqual([
      "location_provider_id",
      "provider_id",
    ]);
  });

  it("covers every distinct linked table exactly once", () => {
    const tables = providerLinkTables().map((t) => t.table);
    expect(new Set(tables).size).toBe(tables.length);
  });
});

describe("formatMergeImpact (count-only, no PHI detail)", () => {
  const impact = (
    perTable: { table: string; count: number }[],
    profiles: number
  ): ProviderMergeImpact => ({
    perTable,
    profiles,
    total: perTable.reduce((n, t) => n + t.count, 0),
  });

  it("summarizes non-zero buckets with a profile count", () => {
    expect(
      formatMergeImpact(
        impact(
          [
            { table: "medical_records", count: 14 },
            { table: "encounters", count: 3 },
            { table: "intake_items", count: 0 },
          ],
          2
        )
      )
    ).toBe("14 records · 3 visits across 2 profiles");
  });

  it("singularizes counts of one and a single profile", () => {
    expect(
      formatMergeImpact(impact([{ table: "encounters", count: 1 }], 1))
    ).toBe("1 visit across 1 profile");
  });

  it("returns null when nothing links the absorbed provider", () => {
    expect(
      formatMergeImpact(impact([{ table: "encounters", count: 0 }], 0))
    ).toBe(null);
  });
});

describe("formatProviderMergeAudit (issue #655 — absorb detail)", () => {
  const impact = (
    perTable: { table: string; count: number }[]
  ): ProviderMergeImpact => ({
    perTable,
    profiles: 1,
    total: perTable.reduce((n, t) => n + t.count, 0),
  });

  it("records the absorbed id + name, surviving id, and per-table counts", () => {
    expect(
      formatProviderMergeAudit({
        survivorId: 7,
        absorbedId: 12,
        absorbedName: "Dr. Drop",
        impact: impact([
          { table: "encounters", count: 3 },
          { table: "procedures", count: 1 },
          { table: "medical_records", count: 0 },
        ]),
      })
    ).toBe('absorbed #12 "Dr. Drop" into #7; re-pointed 3 visits, 1 procedure');
  });

  it("omits the counts clause when nothing linked the absorbed provider", () => {
    expect(
      formatProviderMergeAudit({
        survivorId: 2,
        absorbedId: 5,
        absorbedName: "Empty Clinic",
        impact: impact([{ table: "encounters", count: 0 }]),
      })
    ).toBe('absorbed #5 "Empty Clinic" into #2');
  });
});

// ── The #201 bound-list guard ────────────────────────────────────────────────
// PROVIDER_LINK_COLUMNS must equal EVERY provider-link column the schema declares
// (a column named provider_id / location_provider_id in a CREATE TABLE). A future
// migration that adds a provider link to a new table but forgets to list it here
// fails this test — so the merge can never silently strand rows on a deleted
// duplicate (the exact drift the row-ops convention warns about).

// A provider-link column is one whose name ends in `provider_id` — so `provider_id`,
// `location_provider_id`, and the imaging study's `ordering_provider_id` /
// `reading_provider_id` (#702) all match. Matched as `<name> INTEGER`, which catches both
// the bare-INTEGER and the `INTEGER REFERENCES providers(id)` forms.
const PROVIDER_LINK_COLUMN = /\b(\w*provider_id)\s+INTEGER\b/g;

// Every (table, column) the schema declares a provider link on, under the tables' FINAL
// names, deduped across migrations. The corpus read is the shared one
// (lib/__tests__/migration-schema-scan.ts): EVERY migration file in both naming eras,
// with rebuild scratch and renames resolved before retirement.
//
// It used to be a private copy here, filtered to `/^\d{3}-/` — the CLOSED numbered era —
// which is the same blind spot #2995 found in the OWNED_TABLES guard one file over: a
// provider link added by a name-keyed migration was invisible, so the drift this test
// exists to catch could land unseen. Widening needs the rename resolution to come with
// it, or the #2877 rebuild's `medical_records__new_2877` — which the old
// `endsWith("_new")` scratch rule does not match either — gets reported as a table in
// its own right.
//
// This is the name-based twin of the FK-target reflection in
// provider-link-reflection.test.ts.
function schemaProviderLinks(dbSrc: string): Set<string> {
  const renames = tableRenames(dbSrc);
  const retired = tablesRetired(dbSrc, renames);
  const out = new Set<string>();
  const add = (table: string, column: string) => {
    const final = finalTableName(table, renames);
    if (!retired.has(final)) out.add(`${final}.${column}`);
  };
  for (const { name, body } of createdTables(dbSrc))
    for (const c of body.matchAll(PROVIDER_LINK_COLUMN)) add(name, c[1]);
  // A provider link can ALSO be ALTER-added to an existing table (e.g.
  // medication_courses.provider_id, the #1204 per-course prescriber link, added by
  // migration 091 to a baseline table). Scan `ALTER TABLE <t> ADD COLUMN <…provider_id>
  // INTEGER` too so those links are reflected the same as CREATE TABLE ones.
  for (const a of dbSrc.matchAll(
    /ALTER TABLE\s+(\w+)\s+ADD COLUMN\s+(\w*provider_id)\s+INTEGER\b/g
  ))
    add(a[1], a[2]);
  return out;
}

describe("provider-link column set: single source of truth (no drift)", () => {
  it("PROVIDER_LINK_COLUMNS equals every provider link the schema declares", () => {
    const declared = schemaProviderLinks(migrationSources());
    // Guard against a broken parse silently passing.
    expect(declared.size).toBeGreaterThan(5);
    const listed = new Set(
      PROVIDER_LINK_COLUMNS.map((l) => `${l.table}.${l.column}`)
    );
    expect([...listed].sort()).toEqual([...declared].sort());
  });

  // Both directions, on SYNTHETIC migration text in the name-keyed era's shape — the era
  // the old `/^\d{3}-/` read could not see at all (#2995).
  it("a provider link added by a name-keyed migration is seen", () => {
    expect([
      ...schemaProviderLinks(
        `db.exec(\`CREATE TABLE referrals (
           id INTEGER PRIMARY KEY,
           provider_id INTEGER REFERENCES providers(id)
         );\`);`
      ),
    ]).toEqual(["referrals.provider_id"]);
    expect([
      ...schemaProviderLinks(
        "db.exec(`ALTER TABLE encounters ADD COLUMN referring_provider_id INTEGER;`);"
      ),
    ]).toEqual(["encounters.referring_provider_id"]);
  });

  it("a rebuild's scratch table is reported under the final name, once", () => {
    // `medical_records__new_2877`'s real shape: the #2877 scratch matches no `_new`
    // suffix rule, so it is recognised as scratch by BEING RENAMED AWAY.
    expect([
      ...schemaProviderLinks(`
        CREATE TABLE medical_records (id INTEGER, provider_id INTEGER);
        CREATE TABLE medical_records__new_2877 (
          id INTEGER,
          provider_id INTEGER,
          ordering_provider_id INTEGER
        );
        DROP TABLE medical_records;
        ALTER TABLE medical_records__new_2877 RENAME TO medical_records;`),
    ]).toEqual([
      "medical_records.provider_id",
      "medical_records.ordering_provider_id",
    ]);
  });
});
