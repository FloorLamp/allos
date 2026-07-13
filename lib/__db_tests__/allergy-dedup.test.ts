// DB INTEGRATION TIER — "Recorded allergies" must get the same cross-document
// dedup its clinical-list siblings (conditions/procedures/family history/visits)
// have (#134/#384): the same allergy stored once per uploaded document collapses
// to ONE representative in the manager list and its count, while a genuinely
// different reaction or status stays visible. Storage is untouched — getAllergy
// (single) still reaches each physical row by id.
//
// Runs against a throwaway DB redirected by lib/__db_tests__/setup.ts. Synthetic
// substances only (no PHI).

import { describe, it, expect } from "vitest";
import { getAllergies, getAllergy, searchAll } from "@/lib/queries";
import { getTimelineEvents } from "@/lib/timeline";
import { db } from "@/lib/db";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function newDoc(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents (profile_id, filename, stored_path, extraction_status)
         VALUES (?, 'ccd.xml', '', 'done')`
      )
      .run(profileId).lastInsertRowid
  );
}

function insertAllergy(
  profileId: number,
  substance: string,
  reaction: string | null,
  status: string,
  documentId: number | null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO allergies (profile_id, substance, reaction, status, document_id)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(profileId, substance, reaction, status, documentId).lastInsertRowid
  );
}

describe("getAllergies cross-document dedup (#384)", () => {
  it("collapses the same allergy carried by two overlapping documents", () => {
    const p = newProfile("allergy-twins");
    const d1 = newDoc(p);
    const d2 = newDoc(p);
    insertAllergy(p, "Penicillin", "Hives", "active", d1);
    insertAllergy(p, "Penicillin", "Hives", "active", d2);
    const rows = getAllergies(p);
    expect(rows.filter((r) => r.substance === "Penicillin")).toHaveLength(1);
  });

  it("keeps a manual row and its imported twin as one (prefers the manual)", () => {
    const p = newProfile("allergy-manual");
    const d1 = newDoc(p);
    const manualId = insertAllergy(p, "Latex", "Rash", "active", null);
    insertAllergy(p, "Latex", "Rash", "active", d1);
    const rows = getAllergies(p).filter((r) => r.substance === "Latex");
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(manualId); // manual representative wins
  });

  it("keeps genuinely different reactions or statuses distinct", () => {
    const p = newProfile("allergy-distinct");
    const d1 = newDoc(p);
    insertAllergy(p, "Sulfa", "Hives", "active", d1);
    insertAllergy(p, "Sulfa", "Anaphylaxis", "active", d1); // different reaction
    insertAllergy(p, "Sulfa", "Hives", "resolved", d1); // different status
    const rows = getAllergies(p).filter((r) => r.substance === "Sulfa");
    expect(rows).toHaveLength(3);
  });

  it("still reaches every physical row by id (per-document access preserved)", () => {
    const p = newProfile("allergy-byid");
    const d1 = newDoc(p);
    const d2 = newDoc(p);
    const id1 = insertAllergy(p, "Aspirin", "Wheezing", "active", d1);
    const id2 = insertAllergy(p, "Aspirin", "Wheezing", "active", d2);
    expect(getAllergy(p, id1)?.id).toBe(id1);
    expect(getAllergy(p, id2)?.id).toBe(id2);
  });
});

describe("allergy dedup is identical on Timeline and Search (#617)", () => {
  it("two cross-document duplicate allergies show once everywhere", () => {
    const p = newProfile("allergy-surfaces");
    const d1 = newDoc(p);
    const d2 = newDoc(p);
    insertAllergy(p, "Penicillin", "Hives", "active", d1);
    insertAllergy(p, "Penicillin", "Hives", "active", d2);

    // Page (already deduped post-#384) — the reference count.
    expect(
      getAllergies(p).filter((r) => r.substance === "Penicillin")
    ).toHaveLength(1);

    // Timeline: exactly one allergy event for the pair (was two pre-#617).
    const events = getTimelineEvents(p, { category: "allergy" });
    expect(
      events.filter((e) => e.title === "Penicillin" && e.category === "allergy")
    ).toHaveLength(1);

    // Search: exactly one allergy hit (was two, eating 2 of the domain's slots).
    const groups = searchAll(p, "penicillin");
    const allergyGroup = groups.find((g) => g.domain === "allergy");
    expect(allergyGroup?.hits ?? []).toHaveLength(1);
  });

  it("genuinely distinct allergies still each appear on both surfaces", () => {
    const p = newProfile("allergy-surfaces-distinct");
    const d1 = newDoc(p);
    insertAllergy(p, "Codeine", "Hives", "active", d1);
    insertAllergy(p, "Codeine", "Anaphylaxis", "active", d1); // different reaction

    const events = getTimelineEvents(p, { category: "allergy" });
    expect(
      events.filter((e) => e.title === "Codeine" && e.category === "allergy")
    ).toHaveLength(2);
    const groups = searchAll(p, "codeine");
    const allergyGroup = groups.find((g) => g.domain === "allergy");
    expect(allergyGroup?.hits ?? []).toHaveLength(2);
  });
});
