// DB INTEGRATION TIER (npm run test:db). Guards issue #327: the document-level
// resets (deleteMedicalDocument, reassignDocument, reprocessAllDocuments) must
// sweep orphaned biomarker RETEST/FLAG DISMISSALS, not just orphaned stars.
//
// Both name-keyed side-stores — starred_biomarkers (the pinned tile) and
// upcoming_dismissals (the `biomarker:`/`biomarker-flag:` snooze) — key on a
// REUSABLE canonical name, so any operation that removes a biomarker's last
// reading can orphan either one, and a later document reintroducing that name
// silently inherits the stale pin/snooze (AGENTS.md row-ops: names recycle; the
// #203/#283 class). The per-record edit/delete paths already swept both; before
// #327 the document-level resets swept only stars.
//
// These tests exercise:
//   1. the shared cleanupOrphanBiomarkerKeyedState() wrapper directly — it drops
//      orphaned stars AND both dismissal kinds, keeps still-backed rows, and is
//      profile-scoped,
//   2. deleteMedicalDocument (full action) — deleting a document with the last
//      reading of a starred + snoozed biomarker clears the dismissal too,
//   3. reassignDocument (full action) — the SOURCE profile's now-orphaned dismissal
//      is swept and never leaks to the destination,
//   4. reprocessAllDocuments (full action) — a stale, unbacked dismissal is swept
//      when the bulk reprocess settles.

import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { db } from "@/lib/db";
import { persistDocumentImport } from "@/lib/import-persist";
import { cleanupOrphanBiomarkerKeyedState } from "@/lib/queries";
import {
  biomarkerDismissalKey,
  biomarkerFlagDismissalKey,
} from "@/lib/dismissal-keys";
import type { PersistInput } from "@/lib/import-shape";
import {
  deleteMedicalDocument,
  reassignDocument,
  reprocessAllDocuments,
} from "@/app/(app)/medical/document-actions";
import {
  seedActor,
  createLogin,
  createProfile,
  actAs,
  fd,
} from "@/lib/__action_tests__/harness";

const DATE = "2020-05-01";

// A minimal one-lab-record import: a Glucose reading is all these side-state tests
// need to back (or, once deleted, orphan) a star + dismissal.
function glucoseInput(): PersistInput {
  return {
    records: [
      {
        category: "lab",
        name: "Glucose",
        canonical: "Glucose",
        value: "95",
        value_num: 95,
        unit: "mg/dL",
        date: DATE,
        reference_range: null,
        flag: null,
        panel: null,
        notes: null,
        source: null,
        external_id: "obs:glucose",
        loinc: null,
        provider: null,
      },
    ],
    immunizations: [],
    allergies: [],
    conditions: [],
    encounters: [],
    procedures: [],
    familyHistory: [],
    carePlanItems: [],
    careGoals: [],
    bodyMetrics: [],
    heights: [],
    headCircs: [],
    demographics: null,
    meta: {
      docType: "ccd",
      source: "ccd",
      documentDate: DATE,
      patientName: null,
      raw: null,
      model: null,
      importReport: null,
    },
    canonicalNamesToRegister: [],
    providers: [],
  };
}

function newDocument(
  profileId: number,
  opts: { storedPath?: string; status?: string } = {}
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents
           (profile_id, filename, stored_path, extraction_status, doc_type)
         VALUES (?, 'doc.ccd', ?, ?, 'ccd')`
      )
      .run(profileId, opts.storedPath ?? "", opts.status ?? "processing")
      .lastInsertRowid
  );
}

function starOf(profileId: number, name: string): void {
  db.prepare(
    "INSERT INTO starred_biomarkers (profile_id, canonical_name) VALUES (?, ?)"
  ).run(profileId, name);
}

function dismiss(profileId: number, signalKey: string): void {
  db.prepare(
    `INSERT INTO upcoming_dismissals (profile_id, signal_key, snooze_until, dismissed_at)
     VALUES (?, ?, '2999-01-01', datetime('now'))`
  ).run(profileId, signalKey);
}

function hasDismissal(profileId: number, signalKey: string): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM upcoming_dismissals WHERE profile_id = ? AND signal_key = ?"
      )
      .get(profileId, signalKey)
  );
}

function hasStar(profileId: number, name: string): boolean {
  return Boolean(
    db
      .prepare(
        "SELECT 1 FROM starred_biomarkers WHERE profile_id = ? AND canonical_name = ? COLLATE NOCASE"
      )
      .get(profileId, name)
  );
}

describe("cleanupOrphanBiomarkerKeyedState (the shared wrapper)", () => {
  it("drops orphaned stars AND both dismissal kinds, keeping still-backed rows", () => {
    const p = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('KEYED')").run()
        .lastInsertRowid
    );
    // Glucose is backed by a real reading; LDL is not (its readings are "gone").
    db.prepare(
      `INSERT INTO medical_records (profile_id, category, name, canonical_name, value, date)
       VALUES (?, 'lab', 'Glucose', 'Glucose', '95', ?)`
    ).run(p, DATE);

    // Backed side-state — must SURVIVE.
    starOf(p, "Glucose");
    dismiss(p, biomarkerDismissalKey("Glucose"));
    dismiss(p, biomarkerFlagDismissalKey("Glucose"));
    // Orphaned side-state — must be SWEPT.
    starOf(p, "LDL");
    dismiss(p, biomarkerDismissalKey("LDL"));
    dismiss(p, biomarkerFlagDismissalKey("LDL"));

    cleanupOrphanBiomarkerKeyedState(p);

    expect(hasStar(p, "Glucose")).toBe(true);
    expect(hasDismissal(p, biomarkerDismissalKey("Glucose"))).toBe(true);
    expect(hasDismissal(p, biomarkerFlagDismissalKey("Glucose"))).toBe(true);

    expect(hasStar(p, "LDL")).toBe(false);
    expect(hasDismissal(p, biomarkerDismissalKey("LDL"))).toBe(false);
    expect(hasDismissal(p, biomarkerFlagDismissalKey("LDL"))).toBe(false);
  });

  it("is profile-scoped — another profile's identical orphan rows are untouched", () => {
    const a = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('SCOPE-A')").run()
        .lastInsertRowid
    );
    const b = Number(
      db.prepare("INSERT INTO profiles (name) VALUES ('SCOPE-B')").run()
        .lastInsertRowid
    );
    // Both profiles hold an orphaned LDL dismissal (neither has a backing reading).
    dismiss(a, biomarkerDismissalKey("LDL"));
    dismiss(b, biomarkerDismissalKey("LDL"));

    cleanupOrphanBiomarkerKeyedState(a);

    expect(hasDismissal(a, biomarkerDismissalKey("LDL"))).toBe(false);
    // B's row is left alone — the sweep never crosses the profile boundary.
    expect(hasDismissal(b, biomarkerDismissalKey("LDL"))).toBe(true);
  });
});

describe("deleteMedicalDocument sweeps the orphaned retest/flag dismissal (#327)", () => {
  it("clears the star AND both dismissals when the deleted doc held the last reading", async () => {
    const { profile } = seedActor();
    const docId = newDocument(profile.id);
    persistDocumentImport(profile.id, docId, glucoseInput());
    // The user pinned Glucose and snoozed both its retest nudge and its flagged
    // result — all keyed on the canonical name, all backed only by this document.
    starOf(profile.id, "Glucose");
    dismiss(profile.id, biomarkerDismissalKey("Glucose"));
    dismiss(profile.id, biomarkerFlagDismissalKey("Glucose"));

    await expect(
      deleteMedicalDocument(fd({ id: docId }))
    ).resolves.toBeUndefined();

    // Document gone → its Glucose reading gone → the star AND both dismissals are
    // swept, so a later document reintroducing "Glucose" re-nudges instead of being
    // silenced by these stale rows.
    expect(hasStar(profile.id, "Glucose")).toBe(false);
    expect(hasDismissal(profile.id, biomarkerDismissalKey("Glucose"))).toBe(
      false
    );
    expect(hasDismissal(profile.id, biomarkerFlagDismissalKey("Glucose"))).toBe(
      false
    );
  });
});

describe("reassignDocument sweeps the SOURCE profile's orphaned dismissal (#327)", () => {
  it("clears the moved-away biomarker's dismissal on the source and never leaks it to the destination", async () => {
    const admin = createLogin({ role: "admin" });
    const a = createProfile("RA-SRC");
    const b = createProfile("RA-DEST");
    const docId = newDocument(a.id);
    persistDocumentImport(a.id, docId, glucoseInput());
    // Snooze + pin Glucose on the SOURCE profile; the reading is this document's.
    starOf(a.id, "Glucose");
    dismiss(a.id, biomarkerDismissalKey("Glucose"));
    actAs(admin, a);

    const res = await reassignDocument(fd({ id: docId, destProfileId: b.id }));
    expect(res.status).toBe("done");

    // The reading left A → A's now-orphaned star + dismissal are swept …
    expect(hasStar(a.id, "Glucose")).toBe(false);
    expect(hasDismissal(a.id, biomarkerDismissalKey("Glucose"))).toBe(false);
    // … and the dismissal was NEVER copied to B (B only gained the reading, not the
    // suppression), so B's retest nudge is free to fire.
    expect(hasDismissal(b.id, biomarkerDismissalKey("Glucose"))).toBe(false);
  });
});

describe("reprocessAllDocuments sweeps stale dismissals when it settles (#327)", () => {
  it("clears a now-unbacked biomarker dismissal after the bulk reprocess runs", async () => {
    const { profile } = seedActor();
    // A stored, non-health-record file so beginReprocess reads a real buffer; with
    // no AI key the doc is marked 'skipped' (records untouched) but the trailing
    // cleanupOrphanBiomarkerKeyedState still runs — which is the line under test.
    const dir = path.join(
      process.cwd(),
      "data",
      "uploads",
      "medical",
      String(profile.id)
    );
    fs.mkdirSync(dir, { recursive: true });
    const stored = path.join(dir, `reprocess-327-${profile.id}.bin`);
    fs.writeFileSync(stored, "not a health record");
    const relPath = path.relative(process.cwd(), stored);
    const docId = newDocument(profile.id, {
      storedPath: relPath,
      status: "done",
    });
    persistDocumentImport(profile.id, docId, glucoseInput());

    // A stale dismissal for a biomarker the profile has NO reading of (e.g. an old
    // canonical name a prior extraction produced that this document no longer backs).
    dismiss(profile.id, biomarkerDismissalKey("Homocysteine"));
    // A dismissal that IS backed (Glucose) — must survive.
    dismiss(profile.id, biomarkerDismissalKey("Glucose"));

    try {
      const res = await reprocessAllDocuments();
      expect(res.status).toBe("done");

      expect(
        hasDismissal(profile.id, biomarkerDismissalKey("Homocysteine"))
      ).toBe(false);
      expect(hasDismissal(profile.id, biomarkerDismissalKey("Glucose"))).toBe(
        true
      );
    } finally {
      fs.rmSync(stored, { force: true });
    }
  });
});
