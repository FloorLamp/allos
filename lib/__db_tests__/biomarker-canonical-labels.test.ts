// DB INTEGRATION TIER — the query layer hands surfaces the CANONICAL analyte name
// (#1501).
//
// `medical_records.name` is the raw string the lab/CCD delivered ("URIC ACID");
// `canonical_name` is that name snapped onto the controlled vocabulary, which is
// already clean, deliberately-cased display text ("Uric Acid"). Two read paths
// built their user-facing label from the raw column while holding the canonical
// one — and both of them ALSO build a link that keys on the canonical name, so the
// row said one thing and opened another:
//   • getProviderLabs — the provider detail page's "Labs" activity list
//   • getSyncRowProvenance — the Connected-sources per-row drill-in, whose label
//     precedence was literally `name || canonical_name` (raw first)
//
// The pure guard (lib/__tests__/biomarker-canonical-render.test.ts) scans RENDER
// sites; a defect that lives in the SELECT is invisible to it, which is why these
// two need a DB-tier fixture. Synthetic analytes only (no PHI).

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { getProviderLabs, getSyncRowProvenance } from "@/lib/queries";

const RAW = "URIC ACID";
const CANONICAL = "Uric Acid";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function newProvider(name: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO providers (name, type, dedup_key) VALUES (?, 'organization', ?)"
      )
      .run(name, name.toLowerCase()).lastInsertRowid
  );
}

function newRecord(
  profileId: number,
  opts: { canonical: string | null; providerId?: number }
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, canonical_name, value, value_num, unit, provider_id)
         VALUES (?, '2024-02-02', 'lab', ?, ?, '6.1', 6.1, 'mg/dL', ?)`
      )
      .run(profileId, RAW, opts.canonical, opts.providerId ?? null)
      .lastInsertRowid
  );
}

describe("getProviderLabs labels by the canonical analyte (#1501)", () => {
  it("shows the vocabulary's clean name, not the lab's raw string", () => {
    const p = newProfile("canon-provider");
    const provider = newProvider("Test Reference Lab");
    newRecord(p, { canonical: CANONICAL, providerId: provider });

    const labs = getProviderLabs(p, provider);
    expect(labs.map((l) => l.label)).toEqual([CANONICAL]);
  });

  it("falls back to the raw name for an uncanonicalized reading", () => {
    const p = newProfile("canon-provider-miss");
    const provider = newProvider("Test Reference Lab 2");
    newRecord(p, { canonical: null, providerId: provider });

    expect(getProviderLabs(p, provider).map((l) => l.label)).toEqual([RAW]);
  });

  it("treats a blank canonical as a miss rather than rendering an empty label", () => {
    const p = newProfile("canon-provider-blank");
    const provider = newProvider("Test Reference Lab 3");
    newRecord(p, { canonical: "   ", providerId: provider });

    expect(getProviderLabs(p, provider).map((l) => l.label)).toEqual([RAW]);
  });
});

describe("getSyncRowProvenance labels by the canonical analyte (#1501)", () => {
  function eventWithRecord(profileId: number, recordId: number): number {
    const eventId = Number(
      db
        .prepare(
          `INSERT INTO integration_sync_events
             (profile_id, provider, at, ok, inserted, updated, unchanged)
           VALUES (?, 'health-connect', '2024-02-02T09:00:00Z', 1, 1, 0, 0)`
        )
        .run(profileId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO integration_sync_rows
         (event_id, target_table, target_id, disposition)
       VALUES (?, 'medical_records', ?, 'inserted')`
    ).run(eventId, recordId);
    return eventId;
  }

  it("names the row the way the link it carries resolves", () => {
    const p = newProfile("canon-sync");
    const recordId = newRecord(p, { canonical: CANONICAL });
    const eventId = eventWithRecord(p, recordId);

    const [row] = getSyncRowProvenance(p, eventId);
    expect(row.label).toBe(CANONICAL);
    // The label and the href name the SAME identity — that agreement is the point.
    expect(row.href).toContain(encodeURIComponent(CANONICAL));
  });

  it("falls back to the raw name when the reading was never canonicalized", () => {
    const p = newProfile("canon-sync-miss");
    const recordId = newRecord(p, { canonical: null });
    const eventId = eventWithRecord(p, recordId);

    expect(getSyncRowProvenance(p, eventId)[0].label).toBe(RAW);
  });
});
