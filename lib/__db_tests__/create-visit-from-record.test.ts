// DB INTEGRATION TIER (#1099): "Create a visit from this record?" — the accept
// creates a provenance-marked skeleton encounter AND links the source record atomically,
// the derived vision encounter satisfies vision_exam via the normal encounter path, a
// later same-day import does not clobber the derived row, the guard suppresses create
// when an encounter already exists that day, and a decline is remembered. Deterministic:
// :memory:-style per-file temp DB via setup.ts.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { setUserBirthdate, setUserSex } from "@/lib/settings";
import {
  createVisitFromRecord,
  createVisitOfferForRecord,
  createVisitOffers,
  declineCreateVisit,
  getInferredPreventiveSatisfactions,
} from "@/lib/queries";

function makeProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setUserBirthdate(id, "1980-01-01");
  setUserSex(id, "male");
  return id;
}

function makeOpticalRx(
  profileId: number,
  issuedDate: string,
  over: { providerId?: number | null; externalId?: string | null } = {}
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO optical_prescriptions
           (profile_id, kind, issued_date, provider_id, external_id, source)
         VALUES (?, 'glasses', ?, ?, ?, ?)`
      )
      .run(
        profileId,
        issuedDate,
        over.providerId ?? null,
        over.externalId ?? null,
        over.externalId ? "import" : null
      ).lastInsertRowid
  );
}

const RX_DATE = "2026-05-12";

let profileId: number;
beforeEach(() => {
  profileId = makeProfile("Create Visit Test");
});

describe("createVisitFromRecord — accept", () => {
  it("creates a provenance-marked encounter and links the record atomically", () => {
    const providerId = Number(
      db
        .prepare(
          "INSERT INTO providers (name, type, dedup_key) VALUES ('Dr. Eye (test)', 'individual', 'test:dr-eye')"
        )
        .run().lastInsertRowid
    );
    const rxId = makeOpticalRx(profileId, RX_DATE, { providerId });

    const encId = createVisitFromRecord(profileId, "optical", rxId);
    expect(encId).toBeTruthy();

    const enc = db
      .prepare("SELECT * FROM encounters WHERE id = ? AND profile_id = ?")
      .get(encId, profileId) as {
      date: string;
      type: string;
      provider_id: number | null;
      source: string | null;
      external_id: string | null;
    };
    expect(enc.date).toBe(RX_DATE);
    expect(enc.type).toBe("Eye exam");
    expect(enc.provider_id).toBe(providerId);
    expect(enc.source).toBe("derived-from-record");
    expect(enc.external_id).toBe(`derived:optical:${rxId}`);

    // The record is linked in the same transaction.
    const rx = db
      .prepare(
        "SELECT encounter_id FROM optical_prescriptions WHERE id = ? AND profile_id = ?"
      )
      .get(rxId, profileId) as { encounter_id: number | null };
    expect(rx.encounter_id).toBe(encId);

    // A durable 'linked' decision is recorded (reprocess re-apply).
    const decision = db
      .prepare(
        `SELECT decision FROM visit_link_decisions
          WHERE profile_id = ? AND domain = 'optical' AND decision = 'linked'`
      )
      .get(profileId) as { decision: string } | undefined;
    expect(decision?.decision).toBe("linked");
  });

  it("the derived vision encounter satisfies vision_exam via the normal path", () => {
    const rxId = makeOpticalRx(profileId, RX_DATE);
    createVisitFromRecord(profileId, "optical", rxId);

    // Isolate the ENCOUNTER path from #1098's Rx path: delete the Rx, so only the
    // derived encounter remains — vision_exam is still satisfied, proving the
    // derived encounter is a real vision-kind visit the concept map credits.
    db.prepare("DELETE FROM optical_prescriptions WHERE id = ?").run(rxId);

    expect(
      getInferredPreventiveSatisfactions(profileId).some(
        (s) => s.ruleKey === "vision_exam"
      )
    ).toBe(true);
  });

  it("a later same-day imported encounter does NOT clobber the derived one", () => {
    const rxId = makeOpticalRx(profileId, RX_DATE);
    const encId = createVisitFromRecord(profileId, "optical", rxId);

    // A real encounter for the same visit imports later — a DIFFERENT external_id,
    // so the keyed upsert can never overwrite the derived row; both coexist.
    db.prepare(
      `INSERT INTO encounters (profile_id, date, type, source, external_id)
       VALUES (?, ?, 'Office Visit', 'ccda', 'ext:real-visit-1')`
    ).run(profileId, RX_DATE);

    const rows = db
      .prepare(
        "SELECT id, source FROM encounters WHERE profile_id = ? AND date = ? ORDER BY id"
      )
      .all(profileId, RX_DATE) as { id: number; source: string }[];
    expect(rows).toHaveLength(2);
    expect(
      rows.some((r) => r.id === encId && r.source === "derived-from-record")
    ).toBe(true);
    // The record still links to the derived encounter.
    const rx = db
      .prepare("SELECT encounter_id FROM optical_prescriptions WHERE id = ?")
      .get(rxId) as { encounter_id: number | null };
    expect(rx.encounter_id).toBe(encId);
  });
});

describe("the guard — no create when an encounter already exists that day", () => {
  it("createVisitOfferForRecord returns null and the write core refuses", () => {
    const rxId = makeOpticalRx(profileId, RX_DATE);
    // An encounter already exists on RX_DATE → #1050's link path owns it.
    db.prepare(
      `INSERT INTO encounters (profile_id, date, type) VALUES (?, ?, 'Office Visit')`
    ).run(profileId, RX_DATE);

    expect(createVisitOfferForRecord(profileId, "optical", rxId)).toBeNull();
    expect(createVisitFromRecord(profileId, "optical", rxId)).toBeNull();
    // The Rx stays unlinked (no fabricated encounter).
    const rx = db
      .prepare("SELECT encounter_id FROM optical_prescriptions WHERE id = ?")
      .get(rxId) as { encounter_id: number | null };
    expect(rx.encounter_id).toBeNull();
  });
});

describe("the offer + decline", () => {
  it("offers a create for a dated Rx with no same-day encounter, then remembers a decline", () => {
    const rxId = makeOpticalRx(profileId, RX_DATE);
    expect(
      createVisitOfferForRecord(profileId, "optical", rxId)
    ).not.toBeNull();
    expect(createVisitOffers(profileId, "optical")).toHaveLength(1);

    expect(declineCreateVisit(profileId, "optical", rxId)).toBe(true);

    // Declined → never re-offered.
    expect(createVisitOfferForRecord(profileId, "optical", rxId)).toBeNull();
    expect(createVisitOffers(profileId, "optical")).toHaveLength(0);
  });

  it("a completed dental procedure offers; a non-completed one does not", () => {
    const completed = Number(
      db
        .prepare(
          `INSERT INTO dental_procedures (profile_id, name, status, procedure_date)
           VALUES (?, 'Cleaning', 'completed', ?)`
        )
        .run(profileId, RX_DATE).lastInsertRowid
    );
    const planned = Number(
      db
        .prepare(
          `INSERT INTO dental_procedures (profile_id, name, status, procedure_date)
           VALUES (?, 'Extraction', 'planned', '2026-06-01')`
        )
        .run(profileId).lastInsertRowid
    );
    expect(
      createVisitOfferForRecord(profileId, "dental", completed)
    ).not.toBeNull();
    expect(createVisitOfferForRecord(profileId, "dental", planned)).toBeNull();
  });

  it("is profile-scoped — one profile's record never seeds another's visit", () => {
    const other = makeProfile("Other Create Visit");
    const rxId = makeOpticalRx(profileId, RX_DATE);
    // Attempting to create under the WRONG profile finds no record → null.
    expect(createVisitFromRecord(other, "optical", rxId)).toBeNull();
    expect(
      db
        .prepare("SELECT COUNT(*) AS n FROM encounters WHERE profile_id = ?")
        .get(other) as { n: number }
    ).toEqual({ n: 0 });
  });
});
