// DB INTEGRATION TIER — the two encounter-link gaps closed by #1526 (migration 125):
// skin_lesions and allergies were the ONLY profile-owned clinical observation tables
// with no link to the visit that produced them, and allergies had no attribution of any
// kind (not even a provider).
//
// What this pins, and why each assertion earns its place:
//   • the migration LANDED the columns and pre-existing rows read NULL (an added
//     nullable column must not fabricate a link for history);
//   • both tables joined the visit-link machinery as real DOMAINS, so the reads their
//     siblings already had (encounterForRecord / encountersForRecords /
//     linkedRowsForEncounter) work for them with no per-domain special case;
//   • the ROW-OPS side-state (#199/#200): deleting an encounter NULLs the link and
//     leaves the observation intact — the link carries no ON DELETE precisely because
//     the observation OUTLIVES the visit record. A cascade here would silently delete
//     an allergy that gates drug warnings, which is why this is asserted and not
//     assumed;
//   • profile scoping on every read.
//
// Fixtures are 100% synthetic (a throwaway per-file DB via setup.ts). No AI, no network.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  encounterForRecord,
  encountersForRecords,
  linkedRowsForEncounter,
  linkRecordToEncounter,
  unlinkRecordFromEncounter,
  nullEncounterLinks,
  getEncounterPickerOptions,
  encounterIdForProfile,
} from "@/lib/queries";

function makeProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function makeProvider(name: string, dedupKey: string): number {
  return Number(
    db
      .prepare(
        "INSERT INTO providers (name, type, dedup_key) VALUES (?, 'individual', ?)"
      )
      .run(name, dedupKey).lastInsertRowid
  );
}

function makeEncounter(
  profileId: number,
  date: string,
  type: string,
  providerId: number | null = null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO encounters (profile_id, date, type, class_code, provider_id)
         VALUES (?, ?, ?, 'AMB', ?)`
      )
      .run(profileId, date, type, providerId).lastInsertRowid
  );
}

function makeLesion(
  profileId: number,
  label: string,
  observedDate: string | null,
  encounterId: number | null = null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO skin_lesions
           (profile_id, label, body_region, status, observed_date, finding, encounter_id)
         VALUES (?, ?, 'forearm', 'watch', ?, 'benign-looking, recheck in 3 months', ?)`
      )
      .run(profileId, label, observedDate, encounterId).lastInsertRowid
  );
}

function makeAllergy(
  profileId: number,
  substance: string,
  onsetDate: string | null,
  encounterId: number | null = null,
  providerId: number | null = null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO allergies
           (profile_id, substance, reaction, status, onset_date, encounter_id, provider_id)
         VALUES (?, ?, 'hives', 'active', ?, ?, ?)`
      )
      .run(profileId, substance, onsetDate, encounterId, providerId)
      .lastInsertRowid
  );
}

function lesionRow(id: number): {
  encounter_id: number | null;
  finding: string | null;
} {
  return db
    .prepare(`SELECT encounter_id, finding FROM skin_lesions WHERE id = ?`)
    .get(id) as { encounter_id: number | null; finding: string | null };
}

function allergyRow(id: number): {
  encounter_id: number | null;
  provider_id: number | null;
  substance: string;
} {
  return db
    .prepare(
      `SELECT encounter_id, provider_id, substance FROM allergies WHERE id = ?`
    )
    .get(id) as {
    encounter_id: number | null;
    provider_id: number | null;
    substance: string;
  };
}

describe("migration 125 — the columns exist and history reads NULL", () => {
  it("adds skin_lesions.encounter_id and allergies.encounter_id + provider_id", () => {
    const cols = (table: string) =>
      new Set(
        (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]) //
          .map((c) => c.name)
      );
    expect(cols("skin_lesions").has("encounter_id")).toBe(true);
    expect(cols("allergies").has("encounter_id")).toBe(true);
    expect(cols("allergies").has("provider_id")).toBe(true);
  });

  it("declares each new column as a real FK with NO ON DELETE (the observation outlives the visit)", () => {
    const fks = (table: string) =>
      db.pragma(`foreign_key_list(${table})`) as {
        table: string;
        from: string;
        on_delete: string;
      }[];
    const lesionEnc = fks("skin_lesions").find(
      (f) => f.from === "encounter_id"
    );
    expect(lesionEnc?.table).toBe("encounters");
    expect(lesionEnc?.on_delete).toBe("NO ACTION");
    const allergyEnc = fks("allergies").find((f) => f.from === "encounter_id");
    expect(allergyEnc?.table).toBe("encounters");
    expect(allergyEnc?.on_delete).toBe("NO ACTION");
    const allergyProv = fks("allergies").find((f) => f.from === "provider_id");
    expect(allergyProv?.table).toBe("providers");
    expect(allergyProv?.on_delete).toBe("NO ACTION");
  });

  it("leaves an existing row's link NULL — an added column fabricates nothing", () => {
    const profileId = makeProfile("history");
    const lesionId = makeLesion(profileId, "Upper back mole", "2024-06-01");
    const allergyId = makeAllergy(profileId, "Penicillin", "2019-04-02");
    expect(lesionRow(lesionId).encounter_id).toBeNull();
    expect(allergyRow(allergyId).encounter_id).toBeNull();
    expect(allergyRow(allergyId).provider_id).toBeNull();
    // ...and an unlinked row is simply ABSENT from the batch map, never a null entry.
    expect(encountersForRecords(profileId, "skin")[lesionId]).toBeUndefined();
    expect(
      encountersForRecords(profileId, "allergy")[allergyId]
    ).toBeUndefined();
  });
});

describe("skin + allergy as visit-link domains (#1526)", () => {
  it("reads the linked visit for one row and for the whole domain, profile-scoped", () => {
    const profileId = makeProfile("linked-reads");
    const providerId = makeProvider("Dr. Okafor", "dk:dr-okafor-1526");
    const encId = makeEncounter(
      profileId,
      "2026-05-04",
      "Dermatology",
      providerId
    );
    const lesionId = makeLesion(
      profileId,
      "Left forearm mole",
      "2026-05-04",
      encId
    );
    const allergyId = makeAllergy(
      profileId,
      "Amoxicillin",
      "2026-05-04",
      encId,
      providerId
    );
    const unlinkedLesion = makeLesion(profileId, "Scalp spot", "2026-01-09");

    const one = encounterForRecord(profileId, "skin", lesionId);
    expect(one?.id).toBe(encId);
    expect(one?.type).toBe("Dermatology");
    expect(one?.providerName).toBe("Dr. Okafor");
    expect(one?.date).toBe("2026-05-04");
    expect(encounterForRecord(profileId, "skin", unlinkedLesion)).toBeNull();

    // The batch inverse the records surfaces render, for both new domains.
    const lesionMap = encountersForRecords(profileId, "skin");
    expect(lesionMap[lesionId]?.id).toBe(encId);
    expect(lesionMap[unlinkedLesion]).toBeUndefined();
    expect(encountersForRecords(profileId, "allergy")[allergyId]?.id).toBe(
      encId
    );

    // The encounter detail's "From this visit" list now carries both rows.
    const rows = linkedRowsForEncounter(profileId, encId);
    expect(
      rows.find((r) => r.domain === "skin" && r.id === lesionId)?.label
    ).toBe("Left forearm mole");
    expect(
      rows.find((r) => r.domain === "allergy" && r.id === allergyId)?.label
    ).toBe("Amoxicillin");

    // Profile isolation: another profile sees neither row nor link.
    const other = makeProfile("linked-reads-other");
    expect(encounterForRecord(other, "skin", lesionId)).toBeNull();
    expect(encountersForRecords(other, "allergy")).toEqual({});
    expect(linkedRowsForEncounter(other, encId)).toEqual([]);
  });

  it("links and unlinks through the shared write core", () => {
    const profileId = makeProfile("link-write");
    const encId = makeEncounter(profileId, "2026-02-02", "Allergy clinic");
    const allergyId = makeAllergy(profileId, "Latex", "2026-02-02");

    expect(linkRecordToEncounter(profileId, "allergy", allergyId, encId)).toBe(
      true
    );
    expect(allergyRow(allergyId).encounter_id).toBe(encId);
    expect(unlinkRecordFromEncounter(profileId, "allergy", allergyId)).toBe(
      true
    );
    expect(allergyRow(allergyId).encounter_id).toBeNull();

    // A forged id from another profile links nothing.
    const other = makeProfile("link-write-other");
    expect(linkRecordToEncounter(other, "allergy", allergyId, encId)).toBe(
      false
    );
    expect(allergyRow(allergyId).encounter_id).toBeNull();
  });

  it("falls back to the body-map region when a lesion has no label", () => {
    const profileId = makeProfile("label-fallback");
    const encId = makeEncounter(profileId, "2026-03-03", "Dermatology");
    const lesionId = Number(
      db
        .prepare(
          `INSERT INTO skin_lesions
             (profile_id, body_region, status, observed_date, encounter_id)
           VALUES (?, 'shoulder', 'active', '2026-03-03', ?)`
        )
        .run(profileId, encId).lastInsertRowid
    );
    const row = linkedRowsForEncounter(profileId, encId).find(
      (r) => r.domain === "skin" && r.id === lesionId
    );
    expect(row?.label).toBe("shoulder");
  });
});

describe("row-ops side-state: deleting the visit NULLs the link, never the row", () => {
  it("nullEncounterLinks frees both new links and leaves the observations intact", () => {
    const profileId = makeProfile("enc-delete");
    const encId = makeEncounter(profileId, "2026-04-04", "Dermatology");
    const lesionId = makeLesion(profileId, "Shin mole", "2026-04-04", encId);
    const allergyId = makeAllergy(profileId, "Shellfish", "2026-04-04", encId);

    // The unlink core, then the delete (mirrors deleteEncounter's order). With
    // foreign_keys ON the delete would THROW if either back-link were still set.
    nullEncounterLinks(profileId, encId);
    db.prepare(`DELETE FROM encounters WHERE id = ? AND profile_id = ?`).run(
      encId,
      profileId
    );

    expect(lesionRow(lesionId).encounter_id).toBeNull();
    expect(allergyRow(allergyId).encounter_id).toBeNull();
    // The observations SURVIVE — and so does the clinical content that makes them
    // worth keeping (the lesion's finding, the allergy that gates drug warnings).
    expect(lesionRow(lesionId).finding).toBe(
      "benign-looking, recheck in 3 months"
    );
    expect(allergyRow(allergyId).substance).toBe("Shellfish");
  });

  it("deleting a linked provider is only reachable through the merge re-point, so the allergy keeps a live link", () => {
    // A provider row is only ever deleted inside mergeProviders, which re-points every
    // PROVIDER_LINK_COLUMNS entry first (allergies.provider_id joined that list in
    // #1526). This pins the FK actually bites, so an un-re-pointed delete cannot slip
    // through as a silent no-op.
    const profileId = makeProfile("provider-delete");
    const providerId = makeProvider("Dr. Strand", "dk:dr-strand-1526");
    const allergyId = makeAllergy(profileId, "Sulfa", null, null, providerId);
    expect(() =>
      db.prepare(`DELETE FROM providers WHERE id = ?`).run(providerId)
    ).toThrow();
    expect(allergyRow(allergyId).provider_id).toBe(providerId);
  });
});

describe("the form-side visit picker (#1526)", () => {
  it("offers the profile's visits newest-first with the fields the shared label needs", () => {
    const profileId = makeProfile("picker");
    const providerId = makeProvider("Dr. Reyes", "dk:dr-reyes-1526");
    const older = makeEncounter(profileId, "2026-01-05", "Dermatology");
    const newer = makeEncounter(
      profileId,
      "2026-06-06",
      "Allergy clinic",
      providerId
    );

    const options = getEncounterPickerOptions(profileId);
    expect(options.map((o) => o.id)).toEqual([newer, older]);
    expect(options[0].type).toBe("Allergy clinic");
    expect(options[0].providerName).toBe("Dr. Reyes");
    expect(options[0].date).toBe("2026-06-06");

    // Another profile is offered nothing of this one's.
    expect(getEncounterPickerOptions(makeProfile("picker-other"))).toEqual([]);
  });

  it("validates a posted id against the profile: blank/garbage/foreign all resolve to no link", () => {
    const profileId = makeProfile("picker-validate");
    const other = makeProfile("picker-validate-other");
    const encId = makeEncounter(profileId, "2026-07-07", "Dermatology");

    expect(encounterIdForProfile(profileId, String(encId))).toBe(encId);
    expect(encounterIdForProfile(profileId, encId)).toBe(encId);
    expect(encounterIdForProfile(profileId, "")).toBeNull();
    expect(encounterIdForProfile(profileId, "not-a-number")).toBeNull();
    expect(encounterIdForProfile(profileId, "0")).toBeNull();
    expect(encounterIdForProfile(profileId, null)).toBeNull();
    // The cross-profile forge: another profile's visit id is refused, so the write
    // stores "no link" rather than leaking or dangling.
    expect(encounterIdForProfile(other, String(encId))).toBeNull();
  });
});
