// DB INTEGRATION TIER (not the pure unit suite in lib/__tests__).
//
// Exercises the provider duplicate-merge (issue #275) against the real schema: the
// transactional re-point across EVERY provider-link column, the count-only impact
// read, and the per-profile scoping of the activity reads. Runs via
// `npm run test:db`; the `db` singleton is a throwaway per-file temp DB.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  mergeProviders,
  getProviderMergeImpact,
  updateProviderIdentity,
  getProvider,
} from "@/lib/providers-db";
import {
  getProviderActivityCounts,
  getProviderActivityTotal,
} from "@/lib/queries/providers";
import { linkAffiliation, getAffiliatesFor } from "@/lib/queries/affiliations";
import { PROVIDER_LINK_COLUMNS } from "@/lib/provider-merge";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function newProvider(name: string, dedup: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO providers (name, type, dedup_key) VALUES (?, 'individual', ?)`
      )
      .run(name, dedup).lastInsertRowid
  );
}

function newTypedProvider(
  name: string,
  type: "individual" | "organization",
  dedup: string
): number {
  return Number(
    db
      .prepare(`INSERT INTO providers (name, type, dedup_key) VALUES (?, ?, ?)`)
      .run(name, type, dedup).lastInsertRowid
  );
}

// Insert one row per provider-link column pointing at `providerId`, for `profileId`.
// Returns the number of rows inserted (one per PROVIDER_LINK_COLUMNS entry).
function linkAllTables(profileId: number, providerId: number): number {
  db.prepare(
    `INSERT INTO medical_records (profile_id, date, category, name, provider_id)
     VALUES (?, '2020-01-01', 'lab', 'Glucose', ?)`
  ).run(profileId, providerId);
  db.prepare(
    `INSERT INTO immunizations (profile_id, date, vaccine, provider_id)
     VALUES (?, '2020-01-01', 'mmr', ?)`
  ).run(profileId, providerId);
  db.prepare(
    `INSERT INTO intake_items (profile_id, name, active, kind, provider_id)
     VALUES (?, 'Vit D', 1, 'supplement', ?)`
  ).run(profileId, providerId);
  db.prepare(
    `INSERT INTO encounters (profile_id, date, provider_id) VALUES (?, '2020-01-02', ?)`
  ).run(profileId, providerId);
  db.prepare(
    `INSERT INTO encounters (profile_id, date, location_provider_id) VALUES (?, '2020-01-03', ?)`
  ).run(profileId, providerId);
  db.prepare(
    `INSERT INTO procedures (profile_id, name, date, provider_id) VALUES (?, 'Colonoscopy', '2020-01-04', ?)`
  ).run(profileId, providerId);
  db.prepare(
    `INSERT INTO care_plan_items (profile_id, description, provider_id) VALUES (?, 'Follow up', ?)`
  ).run(profileId, providerId);
  db.prepare(
    `INSERT INTO appointments (profile_id, scheduled_at, provider_id) VALUES (?, '2030-01-01', ?)`
  ).run(profileId, providerId);
  // Imaging studies carry TWO provider links (ordering + reading) — one row each so
  // there is exactly one referencing row per PROVIDER_LINK_COLUMNS entry (#702).
  db.prepare(
    `INSERT INTO imaging_studies (profile_id, modality, body_region, ordering_provider_id)
     VALUES (?, 'x-ray', 'Chest', ?)`
  ).run(profileId, providerId);
  db.prepare(
    `INSERT INTO imaging_studies (profile_id, modality, body_region, reading_provider_id)
     VALUES (?, 'mri', 'Knee', ?)`
  ).run(profileId, providerId);
  // Optical prescriptions link the prescribing optometrist (#697).
  db.prepare(
    `INSERT INTO optical_prescriptions (profile_id, kind, provider_id)
     VALUES (?, 'glasses', ?)`
  ).run(profileId, providerId);
  // Dental procedures link the performing/recording dentist (#705).
  db.prepare(
    `INSERT INTO dental_procedures (profile_id, name, provider_id)
     VALUES (?, 'Composite filling', ?)`
  ).run(profileId, providerId);
  // Skin lesions link the recording dermatologist (#715).
  db.prepare(
    `INSERT INTO skin_lesions (profile_id, label, provider_id)
     VALUES (?, 'Left forearm mole', ?)`
  ).run(profileId, providerId);
  return PROVIDER_LINK_COLUMNS.length;
}

// Rows still pointing at `providerId`, summed across every provider-link column.
function refsTo(providerId: number): number {
  let total = 0;
  for (const { table, column } of PROVIDER_LINK_COLUMNS) {
    const row = db
      .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} = ?`)
      .get(providerId) as { n: number };
    total += row.n;
  }
  return total;
}

let survivor: number;
let duplicate: number;
let profileA: number;
let profileB: number;

beforeEach(() => {
  // Fresh subjects per test (the temp DB persists across a file's tests).
  survivor = newProvider("Dr. Survivor", `s-${Math.random()}`);
  duplicate = newProvider("Dr. Duplicate", `d-${Math.random()}`);
  profileA = newProfile("A");
  profileB = newProfile("B");
});

describe("mergeProviders re-points every link then deletes the absorbed row", () => {
  it("moves a row from EVERY provider-link column onto the survivor", () => {
    const inserted = linkAllTables(profileA, duplicate);
    expect(refsTo(duplicate)).toBe(inserted);
    expect(refsTo(survivor)).toBe(0);

    mergeProviders(survivor, duplicate);

    // No row still points at the absorbed provider; all moved to the survivor.
    expect(refsTo(duplicate)).toBe(0);
    expect(refsTo(survivor)).toBe(inserted);
    // The absorbed provider row is gone; the survivor remains.
    expect(getProvider(duplicate)).toBeUndefined();
    expect(getProvider(survivor)).toBeDefined();
  });

  it("is link-safe when the survivor already owns rows (idempotent union)", () => {
    linkAllTables(profileA, duplicate);
    linkAllTables(profileA, survivor);
    mergeProviders(survivor, duplicate);
    expect(refsTo(duplicate)).toBe(0);
    expect(refsTo(survivor)).toBe(2 * PROVIDER_LINK_COLUMNS.length);
  });

  it("refuses a self-merge and a missing row", () => {
    expect(() => mergeProviders(survivor, survivor)).toThrow();
    expect(() => mergeProviders(survivor, 999999)).toThrow();
  });
});

describe("getProviderMergeImpact (count-only, global across profiles)", () => {
  it("counts DISTINCT touched rows per table and the profiles touched", () => {
    linkAllTables(profileA, duplicate);
    linkAllTables(profileB, duplicate);
    const impact = getProviderMergeImpact(duplicate);
    // Two encounter rows (attending + facility) per profile → 4 visits total.
    const visits = impact.perTable.find((t) => t.table === "encounters");
    expect(visits?.count).toBe(4);
    const labs = impact.perTable.find((t) => t.table === "medical_records");
    expect(labs?.count).toBe(2);
    expect(impact.profiles).toBe(2);
  });
});

describe("provider activity reads are per-profile scoped", () => {
  it("counts only the acting profile's rows, never another profile's", () => {
    linkAllTables(profileA, survivor);
    linkAllTables(profileB, survivor);
    const a = getProviderActivityCounts(profileA, survivor);
    // encounters: attending + facility rows both name the survivor → 2 visits.
    expect(a.visits).toBe(2);
    expect(a.labs).toBe(1);
    expect(a.medications).toBe(1);
    expect(a.immunizations).toBe(1);
    expect(a.procedures).toBe(1);
    expect(a.carePlan).toBe(1);
    expect(a.appointments).toBe(1);
    // Total for A excludes B's identical rows. 8 core links + the #1088 specialty/
    // imaging domains linkAllTables now also plants: imaging (ordering + reading rows,
    // both count) = 2, vision = 1, dental = 1, skin = 1 → 13.
    expect(getProviderActivityTotal(profileA, survivor)).toBe(
      getProviderActivityTotal(profileB, survivor)
    );
    expect(getProviderActivityTotal(profileA, survivor)).toBe(13);
  });
});

// Row-ops side-state (#1055): merge re-keys affiliation edges onto the survivor,
// dedupes a would-be duplicate pair, and drops a self-edge — the special-cased link
// the reflection test excuses from the generic PROVIDER_LINK_COLUMNS re-point.
describe("mergeProviders re-keys affiliation edges (#1055)", () => {
  it("moves a duplicate individual's affiliation onto the survivor", () => {
    const east = newTypedProvider(
      "Care East",
      "organization",
      `org-${Math.random()}`
    );
    // survivor + duplicate are individuals (from beforeEach). Affiliate the DUPLICATE
    // with the org, then merge it into the survivor.
    expect(linkAffiliation(duplicate, east)).toBe(true);
    expect(getAffiliatesFor(duplicate, "individual").map((a) => a.id)).toEqual([
      east,
    ]);

    mergeProviders(survivor, duplicate);

    // The edge now belongs to the survivor; none dangles on the absorbed row.
    expect(getAffiliatesFor(survivor, "individual").map((a) => a.id)).toEqual([
      east,
    ]);
    const dangling = db
      .prepare(
        `SELECT COUNT(*) AS n FROM provider_affiliations
          WHERE individual_id = ? OR organization_id = ?`
      )
      .get(duplicate, duplicate) as { n: number };
    expect(dangling.n).toBe(0);
  });

  it("dedupes a pair both providers share, leaving one edge and no self-edge", () => {
    const east = newTypedProvider(
      "Shared Org",
      "organization",
      `org2-${Math.random()}`
    );
    linkAffiliation(survivor, east);
    linkAffiliation(duplicate, east);
    mergeProviders(survivor, east === survivor ? duplicate : duplicate);
    const rows = db
      .prepare(
        `SELECT COUNT(*) AS n FROM provider_affiliations WHERE organization_id = ?`
      )
      .get(east) as { n: number };
    expect(rows.n).toBe(1); // the UNIQUE-colliding duplicate was dropped
    // No self-edge (survivor↔survivor) was created.
    const selfEdges = db
      .prepare(
        `SELECT COUNT(*) AS n FROM provider_affiliations WHERE individual_id = organization_id`
      )
      .get() as { n: number };
    expect(selfEdges.n).toBe(0);
  });

  it("keeps the survivor's non-null specialty and un-archives an active-merge pair", () => {
    // The survivor is archived + specialty-less; the duplicate is active + specialized.
    db.prepare(`UPDATE providers SET archived = 1 WHERE id = ?`).run(survivor);
    db.prepare(
      `UPDATE providers SET specialty = 'Cardiology', specialty_code = '207RC0000X', contact_edited = 1 WHERE id = ?`
    ).run(duplicate);
    mergeProviders(survivor, duplicate);
    const s = getProvider(survivor)!;
    expect(s.specialty).toBe("Cardiology"); // inherited (survivor was null)
    expect(s.archived).toBe(0); // active-merge → active
    expect(s.contact_edited).toBe(1); // locked if EITHER was
  });
});

describe("updateProviderIdentity", () => {
  it("rewrites identity fields and recomputes the dedup key", () => {
    updateProviderIdentity(survivor, {
      name: "Dr. Renamed",
      type: "individual",
      npi: "1234567895",
      identifier: null,
      phone: "(555) 010-1234",
      address: null,
    });
    const p = getProvider(survivor)!;
    expect(p.name).toBe("Dr. Renamed");
    expect(p.npi).toBe("1234567895");
  });

  it("refuses an identity that collides with another provider", () => {
    updateProviderIdentity(duplicate, {
      name: "Dr. Duplicate",
      type: "individual",
      npi: "1234567894",
      identifier: null,
      phone: null,
      address: null,
    });
    // Giving the survivor the same NPI would collide on dedup_key.
    expect(() =>
      updateProviderIdentity(survivor, {
        name: "Someone Else",
        type: "individual",
        npi: "1234567894",
        identifier: null,
        phone: null,
        address: null,
      })
    ).toThrow();
  });
});
