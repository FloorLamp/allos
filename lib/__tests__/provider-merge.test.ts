import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROVIDER_LINK_COLUMNS,
  providerLinkTables,
  planProviderMerge,
  formatMergeImpact,
  providerDisambigLabel,
  type ProviderMergeImpact,
} from "@/lib/provider-merge";
import type { Provider } from "@/lib/types";

const REPO = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

function provider(
  p: Partial<Provider> & { id: number; name: string }
): Provider {
  return {
    type: "organization",
    npi: null,
    identifier: null,
    phone: null,
    address: null,
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

// ── The #201 bound-list guard ────────────────────────────────────────────────
// PROVIDER_LINK_COLUMNS must equal EVERY provider-link column the schema declares
// (a column named provider_id / location_provider_id in a CREATE TABLE). A future
// migration that adds a provider link to a new table but forgets to list it here
// fails this test — so the merge can never silently strand rows on a deleted
// duplicate (the exact drift the row-ops convention warns about).

const MIGRATION_VERSIONS_DIR = "lib/migrations/versions";

function migrationSources(): string {
  const dir = path.join(REPO, MIGRATION_VERSIONS_DIR);
  return fs
    .readdirSync(dir)
    .filter((f) => /^\d{3}-.*\.ts$/.test(f))
    .sort()
    .map((f) => fs.readFileSync(path.join(dir, f), "utf8"))
    .join("\n");
}

// Every (table, column) where a CREATE TABLE body declares a provider_id or
// location_provider_id COLUMN (matched as `<name> INTEGER`, which catches both the
// bare-INTEGER and the `INTEGER REFERENCES providers(id)` forms). `_new` rebuild
// scratch tables are ignored; the pair set is deduped across migrations.
function schemaProviderLinks(dbSrc: string): Set<string> {
  const out = new Set<string>();
  const re = /CREATE TABLE (?:IF NOT EXISTS )?(\w+)\s*\(/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(dbSrc))) {
    const name = m[1];
    let i = re.lastIndex;
    let depth = 1;
    let body = "";
    while (i < dbSrc.length && depth > 0) {
      const c = dbSrc[i];
      if (c === "(") depth++;
      else if (c === ")") {
        depth--;
        if (depth === 0) break;
      }
      body += c;
      i++;
    }
    re.lastIndex = i;
    if (name.endsWith("_new")) continue;
    const colRe = /\b(provider_id|location_provider_id)\s+INTEGER\b/g;
    let c: RegExpExecArray | null;
    while ((c = colRe.exec(body))) out.add(`${name}.${c[1]}`);
  }
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
});
