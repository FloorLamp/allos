// DB INTEGRATION TIER — the CLINICAL undo kinds (issue #1847).
//
// Until this landed the undo registry covered activities, weigh-ins, biomarker
// readings, supplements and practices — every low-stakes row — while the medical
// passport deleted for good: an allergy that gates the drug-safety matcher, a
// condition carrying a hand-made correction, an immunization dose, a lesion whose
// delete took its whole photo series with it. This file proves each of those four
// deletes now CAPTURES everything and RESTORES it faithfully, and that the retention
// purge finally reclaims the photo files (and their derived thumbnail siblings) that
// a restore is allowed to depend on until then.
//
// The pure registry assertions live in lib/__tests__/undo-delete.test.ts; the shared
// capture/restore mechanics in lib/__db_tests__/undo-delete.test.ts.

import { describe, it, expect, beforeAll } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import {
  captureDelete,
  emptyTrash,
  purgeDeletedRow,
  restoreDeletedRow,
  sweepDeletedRows,
} from "@/lib/undo-delete-db";
import { storeProcessedPhoto, thumbSiblingPath } from "@/lib/photo/store";
import type { ProcessedPhoto } from "@/lib/photo/ingest";
import { seedProfile, type SeededProfile } from "./fixtures";

let p: SeededProfile;

beforeAll(() => {
  p = seedProfile("CLINUNDO");
});

const one = <T>(sql: string, ...args: unknown[]) =>
  db.prepare(sql).get(...args) as T | undefined;
const count = (sql: string, ...args: unknown[]) =>
  (db.prepare(sql).get(...args) as { c: number }).c;
const abs = (rel: string) => path.resolve(process.cwd(), rel);
const backdate = (undoId: number) =>
  db
    .prepare(
      `UPDATE deleted_rows SET deleted_at = datetime('now', '-2 days') WHERE id = ?`
    )
    .run(undoId);

// A distinct, deterministic "photo": the content hash names the stored file, so a
// distinct hash per test keeps two tests from sharing one path on disk.
function fakePhoto(hash: string): ProcessedPhoto {
  return {
    bytes: Buffer.from(`PHOTO-${hash}`),
    thumbBytes: Buffer.from(`THUMB-${hash}`),
    mime: "image/jpeg",
    width: 40,
    height: 30,
    sizeBytes: 12,
    contentHash: hash,
    captureDate: null,
  };
}

function newLesion(label: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO skin_lesions (profile_id, label, body_region, observed_date, status)
         VALUES (?, ?, 'shoulder', '2026-04-01', 'watch')`
      )
      .run(p.profileId, label).lastInsertRowid
  );
}

// Attach a photo the way the write core does — file store first, then the row — so
// the capture/restore/purge path sees the real (row, file, thumbnail sibling) triple.
function attachPhoto(lesionId: number, hash: string, caption: string): string {
  const { storedPath } = storeProcessedPhoto(
    "lesion",
    p.profileId,
    fakePhoto(hash)
  );
  db.prepare(
    `INSERT INTO lesion_photos
       (profile_id, lesion_id, date, stored_path, content_hash, mime_type, size_bytes, caption)
     VALUES (?, ?, '2026-04-02', ?, ?, 'image/jpeg', 12, ?)`
  ).run(p.profileId, lesionId, storedPath, hash, caption);
  return storedPath;
}

describe("allergy delete → undo (#1847)", () => {
  it("captures the allergy AND its reaction children, then restores both", () => {
    const allergyId = Number(
      db
        .prepare(
          `INSERT INTO allergies
             (profile_id, substance, reaction, severity, status, criticality,
              verification_status, onset_date, notes, source)
           VALUES (?, 'Penicillin', 'Hives', 'severe', 'active', 'high',
                   'confirmed', '2019-03-04', 'ER visit', 'manual')`
        )
        .run(p.profileId).lastInsertRowid
    );
    for (const [m, sev] of [
      ["Hives", "moderate"],
      ["Anaphylaxis", "severe"],
    ] as const)
      db.prepare(
        `INSERT INTO allergy_reactions (allergy_id, manifestation, severity)
         VALUES (?, ?, ?)`
      ).run(allergyId, m, sev);

    const undoId = captureDelete("allergy", p.profileId, allergyId);
    expect(undoId).not.toBeNull();
    expect(
      count("SELECT COUNT(*) c FROM allergies WHERE id = ?", allergyId)
    ).toBe(0);
    // The CASCADE took the manifestations with it — which is exactly why the undo
    // has to bring them back: they carry the severity grades the criticality reads.
    expect(
      count(
        "SELECT COUNT(*) c FROM allergy_reactions WHERE allergy_id = ?",
        allergyId
      )
    ).toBe(0);

    expect(restoreDeletedRow(p.profileId, undoId!)).toBe(true);
    const back = one<{
      id: number;
      criticality: string;
      verification_status: string;
      onset_date: string;
      notes: string;
    }>(
      `SELECT id, criticality, verification_status, onset_date, notes
         FROM allergies WHERE profile_id = ? AND substance = 'Penicillin'`,
      p.profileId
    );
    expect(back).toBeTruthy();
    // Faithful, not approximate: every clinical qualifier comes back as stored.
    expect(back!.criticality).toBe("high");
    expect(back!.verification_status).toBe("confirmed");
    expect(back!.onset_date).toBe("2019-03-04");
    expect(back!.notes).toBe("ER visit");
    const reactions = db
      .prepare(
        `SELECT manifestation, severity FROM allergy_reactions
          WHERE allergy_id = ? ORDER BY manifestation`
      )
      .all(back!.id) as { manifestation: string; severity: string }[];
    expect(reactions).toEqual([
      { manifestation: "Anaphylaxis", severity: "severe" },
      { manifestation: "Hives", severity: "moderate" },
    ]);
  });

  it("restores with a since-deleted document / visit / provider link NULLed", () => {
    const encounterId = Number(
      db
        .prepare(
          `INSERT INTO encounters (profile_id, date, type) VALUES (?, '2026-01-05', 'office')`
        )
        .run(p.profileId).lastInsertRowid
    );
    const providerId = Number(
      db
        .prepare(
          `INSERT INTO providers (name, type, dedup_key)
             VALUES ('Dr Linked', 'individual', 'clinundo:dr-linked')`
        )
        .run().lastInsertRowid
    );
    const allergyId = Number(
      db
        .prepare(
          `INSERT INTO allergies
             (profile_id, substance, status, source, document_id, encounter_id, provider_id)
           VALUES (?, 'Latex', 'active', 'import', ?, ?, ?)`
        )
        .run(p.profileId, p.documentId, encounterId, providerId).lastInsertRowid
    );

    const undoId = captureDelete("allergy", p.profileId, allergyId)!;
    // Every one of the three link targets dies inside the undo window.
    db.prepare("DELETE FROM encounters WHERE id = ?").run(encounterId);
    db.prepare("DELETE FROM providers WHERE id = ?").run(providerId);
    db.prepare("DELETE FROM medical_documents WHERE id = ?").run(p.documentId);

    // The restore must SUCCEED (a verbatim re-insert would abort on the FK) and the
    // allergy comes back with its provenance honestly gone.
    expect(restoreDeletedRow(p.profileId, undoId)).toBe(true);
    const back = one<{
      document_id: number | null;
      encounter_id: number | null;
      provider_id: number | null;
    }>(
      `SELECT document_id, encounter_id, provider_id FROM allergies
        WHERE profile_id = ? AND substance = 'Latex'`,
      p.profileId
    );
    expect(back).toEqual({
      document_id: null,
      encounter_id: null,
      provider_id: null,
    });
  });

  it("adopts a live row that re-took the captured external_id instead of failing", () => {
    const allergyId = Number(
      db
        .prepare(
          `INSERT INTO allergies (profile_id, substance, status, source, external_id)
           VALUES (?, 'Sulfa', 'active', 'mychart', 'ccda:allergy:sulfa')`
        )
        .run(p.profileId).lastInsertRowid
    );
    const undoId = captureDelete("allergy", p.profileId, allergyId)!;
    // A document reprocess re-imports the same source row (INSERT OR IGNORE keyed on
    // the partial UNIQUE(profile_id, external_id)) before the user taps Undo.
    const liveId = Number(
      db
        .prepare(
          `INSERT INTO allergies (profile_id, substance, status, source, external_id)
           VALUES (?, 'Sulfa', 'active', 'mychart', 'ccda:allergy:sulfa')`
        )
        .run(p.profileId).lastInsertRowid
    );
    expect(restoreDeletedRow(p.profileId, undoId)).toBe(true);
    // Adopted, not duplicated: one row on that key, and the holding row is consumed.
    expect(
      count(
        `SELECT COUNT(*) c FROM allergies WHERE profile_id = ? AND external_id = 'ccda:allergy:sulfa'`,
        p.profileId
      )
    ).toBe(1);
    expect(count("SELECT COUNT(*) c FROM allergies WHERE id = ?", liveId)).toBe(
      1
    );
    expect(
      count("SELECT COUNT(*) c FROM deleted_rows WHERE id = ?", undoId)
    ).toBe(0);
  });
});

describe("condition delete → undo (#1847)", () => {
  it("preserves the `edited` edit lock across the round trip", () => {
    const conditionId = Number(
      db
        .prepare(
          `INSERT INTO conditions
             (profile_id, name, status, source, external_id, onset_date, severity, edited)
           VALUES (?, 'Bronchitis (corrected)', 'active', 'episode',
                   'episode:9001', '2026-02-02', 'moderate', 1)`
        )
        .run(p.profileId).lastInsertRowid
    );
    const undoId = captureDelete("condition", p.profileId, conditionId)!;
    expect(restoreDeletedRow(p.profileId, undoId)).toBe(true);
    const back = one<{ edited: number; severity: string; external_id: string }>(
      `SELECT edited, severity, external_id FROM conditions
        WHERE profile_id = ? AND name = 'Bronchitis (corrected)'`,
      p.profileId
    );
    // Restoring an episode-promoted condition WITHOUT its edit lock would hand the
    // row back to syncPromotedCondition, which would overwrite the user's correction
    // on the next episode transition. The flag rides in the snapshot.
    expect(back?.edited).toBe(1);
    expect(back?.severity).toBe("moderate");
    expect(back?.external_id).toBe("episode:9001");
  });

  it("detaches a medication's indication link so the delete lands, and leaves it cleared on undo", () => {
    const conditionId = Number(
      db
        .prepare(
          `INSERT INTO conditions (profile_id, name, status) VALUES (?, 'Hypertension', 'active')`
        )
        .run(p.profileId).lastInsertRowid
    );
    db.prepare(
      `UPDATE intake_items SET indication_condition_id = ? WHERE id = ? AND profile_id = ?`
    ).run(conditionId, p.medicationId, p.profileId);

    // The null-out lives in captureDelete now, so this does not trip the FK.
    const undoId = captureDelete("condition", p.profileId, conditionId)!;
    expect(
      one<{ indication_condition_id: number | null }>(
        "SELECT indication_condition_id FROM intake_items WHERE id = ?",
        p.medicationId
      )?.indication_condition_id
    ).toBeNull();

    expect(restoreDeletedRow(p.profileId, undoId)).toBe(true);
    expect(
      count(
        "SELECT COUNT(*) c FROM conditions WHERE profile_id = ? AND name = 'Hypertension'",
        p.profileId
      )
    ).toBe(1);
    // The documented posture for an inbound null-out (the protocol / follow-up
    // siblings): the condition returns, the med's "For:" link stays honestly cleared.
    expect(
      one<{ indication_condition_id: number | null }>(
        "SELECT indication_condition_id FROM intake_items WHERE id = ?",
        p.medicationId
      )?.indication_condition_id
    ).toBeNull();
  });
});

describe("immunization delete → undo (#1847)", () => {
  it("restores the dose with its administration detail", () => {
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO immunizations
             (profile_id, date, vaccine, dose_label, lot_number, route, site, reaction, notes)
           VALUES (?, '2026-03-03', 'tdap', 'Booster', 'LOT-77', 'intramuscular',
                   'left deltoid', 'sore arm', 'travel clinic')`
        )
        .run(p.profileId).lastInsertRowid
    );
    const undoId = captureDelete("immunization", p.profileId, doseId)!;
    expect(
      count("SELECT COUNT(*) c FROM immunizations WHERE id = ?", doseId)
    ).toBe(0);
    expect(restoreDeletedRow(p.profileId, undoId)).toBe(true);
    const back = one<{
      lot_number: string;
      route: string;
      site: string;
      reaction: string;
      dose_label: string;
    }>(
      `SELECT lot_number, route, site, reaction, dose_label FROM immunizations
        WHERE profile_id = ? AND vaccine = 'tdap' AND date = '2026-03-03'`,
      p.profileId
    );
    expect(back).toEqual({
      lot_number: "LOT-77",
      route: "intramuscular",
      site: "left deltoid",
      reaction: "sore arm",
      dose_label: "Booster",
    });
  });
});

describe("skin-lesion delete → undo (#1847)", () => {
  it("captures the whole photo series and restores it re-pointed at the new lesion id", () => {
    const lesionId = newLesion("Left shoulder mole");
    const pathA = attachPhoto(lesionId, "aaaa1111aaaa1111", "baseline");
    const pathB = attachPhoto(lesionId, "bbbb2222bbbb2222", "six weeks");

    const undoId = captureDelete("skin-lesion", p.profileId, lesionId)!;
    expect(
      count("SELECT COUNT(*) c FROM skin_lesions WHERE id = ?", lesionId)
    ).toBe(0);
    expect(
      count(
        "SELECT COUNT(*) c FROM lesion_photos WHERE lesion_id = ?",
        lesionId
      )
    ).toBe(0);
    // THE FILES SURVIVE THE WINDOW — a restore has to have something to point at.
    expect(fs.existsSync(abs(pathA))).toBe(true);
    expect(fs.existsSync(abs(thumbSiblingPath(pathA)))).toBe(true);
    expect(fs.existsSync(abs(pathB))).toBe(true);

    expect(restoreDeletedRow(p.profileId, undoId)).toBe(true);
    const back = one<{ id: number; status: string; observed_date: string }>(
      `SELECT id, status, observed_date FROM skin_lesions
        WHERE profile_id = ? AND label = 'Left shoulder mole'`,
      p.profileId
    );
    expect(back?.status).toBe("watch");
    const photos = db
      .prepare(
        `SELECT caption, stored_path FROM lesion_photos
          WHERE lesion_id = ? ORDER BY caption`
      )
      .all(back!.id) as { caption: string; stored_path: string }[];
    // The whole series is back, re-parented onto the lesion's NEW id and still
    // pointing at the same files on disk.
    expect(photos).toEqual([
      { caption: "baseline", stored_path: pathA },
      { caption: "six weeks", stored_path: pathB },
    ]);
    expect(fs.existsSync(abs(pathA))).toBe(true);
  });

  it("clears the lesion's follow-up links without destroying the care-plan item", () => {
    const lesionId = newLesion("Follow-up mole");
    db.prepare(
      `UPDATE care_plan_items
          SET source_kind = 'skin', source_skin_lesion_id = ?
        WHERE id = ? AND profile_id = ?`
    ).run(lesionId, p.carePlanItemId, p.profileId);

    const undoId = captureDelete("skin-lesion", p.profileId, lesionId)!;
    const item = one<{
      source_skin_lesion_id: number | null;
      description: string;
    }>(
      "SELECT source_skin_lesion_id, description FROM care_plan_items WHERE id = ?",
      p.carePlanItemId
    );
    // Degraded to a generic care-plan item, not deleted: the planned care survives.
    expect(item?.source_skin_lesion_id).toBeNull();
    expect(item?.description).toBeTruthy();
    expect(restoreDeletedRow(p.profileId, undoId)).toBe(true);
  });
});

// The purge is the moment the side effect can no longer be inverted, so it is the
// moment the files lose their last justification (#1290's rule, applied to the photo
// core by #1847). All three purge paths — the expiry sweep, "Delete permanently" and
// "Empty trash" — must reclaim them, and all three must take the derived THUMBNAIL
// sibling with them: lesion_photos has no thumb_path column, so a purge that read only
// stored_path would leave every thumbnail of a deleted dermatology close-up on disk.
describe("purge reclaims captured lesion photo files (#1847)", () => {
  it("the expiry sweep unlinks the photo AND its thumbnail sibling", () => {
    const lesionId = newLesion("Purge me");
    const stored = attachPhoto(lesionId, "cccc3333cccc3333", "purge");
    const thumb = thumbSiblingPath(stored);
    const undoId = captureDelete("skin-lesion", p.profileId, lesionId)!;

    // A fresh sweep leaves the buffered entry (and its files) alone.
    sweepDeletedRows(1);
    expect(fs.existsSync(abs(stored))).toBe(true);
    expect(fs.existsSync(abs(thumb))).toBe(true);

    backdate(undoId);
    sweepDeletedRows(1);
    expect(fs.existsSync(abs(stored))).toBe(false);
    expect(fs.existsSync(abs(thumb))).toBe(false);
  });

  it("an UNDONE delete keeps its files (the restore re-points at them)", () => {
    const lesionId = newLesion("Undo me");
    const stored = attachPhoto(lesionId, "dddd4444dddd4444", "kept");
    const undoId = captureDelete("skin-lesion", p.profileId, lesionId)!;
    expect(restoreDeletedRow(p.profileId, undoId)).toBe(true);
    // Nothing left to purge, and a later sweep can't reach a restored row's files.
    backdate(undoId);
    sweepDeletedRows(1);
    expect(fs.existsSync(abs(stored))).toBe(true);
    expect(fs.existsSync(abs(thumbSiblingPath(stored)))).toBe(true);
  });

  it("does NOT unlink a file a live row still references (content-hash dedup)", () => {
    const lesionId = newLesion("Dedup source");
    const stored = attachPhoto(lesionId, "eeee5555eeee5555", "shared");
    const undoId = captureDelete("skin-lesion", p.profileId, lesionId)!;

    // The identical capture re-uploaded onto another lesion lands on the SAME
    // content-named file (the store overwrites in place).
    const keeper = newLesion("Dedup keeper");
    const keeperPath = attachPhoto(keeper, "eeee5555eeee5555", "shared again");
    expect(keeperPath).toBe(stored);

    backdate(undoId);
    sweepDeletedRows(1);
    expect(fs.existsSync(abs(stored))).toBe(true);
    expect(fs.existsSync(abs(thumbSiblingPath(stored)))).toBe(true);
  });

  it("Delete permanently unlinks the captured photo immediately", () => {
    const lesionId = newLesion("Hand purge");
    const stored = attachPhoto(lesionId, "ffff6666ffff6666", "by hand");
    const undoId = captureDelete("skin-lesion", p.profileId, lesionId)!;
    expect(purgeDeletedRow(p.profileId, undoId)).toEqual({ kind: "purged" });
    expect(fs.existsSync(abs(stored))).toBe(false);
    expect(fs.existsSync(abs(thumbSiblingPath(stored)))).toBe(false);
  });

  it("Empty trash unlinks every captured photo it purges", () => {
    const lesionId = newLesion("Empty trash");
    const stored = attachPhoto(lesionId, "9999777799997777", "emptied");
    captureDelete("skin-lesion", p.profileId, lesionId);
    expect(emptyTrash(p.profileId)).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(abs(stored))).toBe(false);
    expect(fs.existsSync(abs(thumbSiblingPath(stored)))).toBe(false);
  });
});
