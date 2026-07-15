// SERVER-ACTION TIER — regression for deleteProfile FK-ordering (#729).
//
// The app connection runs `foreign_keys = ON`, and OWNED_TABLES lists
// `medical_documents` BEFORE its FK children (conditions/encounters/procedures/
// family_history/care_plan_items/care_goals/appointments — each carries a
// `document_id REFERENCES medical_documents(id)` FK with no ON DELETE action).
// The OWNED_TABLES sweep therefore ran `DELETE FROM medical_documents` while those
// child rows still referenced it, firing an immediate FK violation that aborted the
// whole delete transaction: a profile that imported clinical narratives (children
// with a non-null document_id) could NOT be deleted. The fix wraps the subtree
// sweep in `foreign_keys = OFF` (restored after) since the whole subtree is removed
// atomically. This test seeds a document + referencing children and asserts the
// delete succeeds, leaves no orphan, and removes the profile. It FAILS against the
// pre-fix code (the constraint aborts the transaction).

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { deleteProfile } from "@/app/(app)/settings/family/actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

// Insert a medical_documents row (filename + stored_path are NOT NULL); return id.
function addDoc(profileId: number): number {
  return Number(
    db
      .prepare(
        `INSERT INTO medical_documents (profile_id, filename, stored_path)
         VALUES (?, 'labs.pdf', '')`
      )
      .run(profileId).lastInsertRowid
  );
}

describe("deleteProfile FK-ordering with imported clinical rows (#729)", () => {
  it("deletes a profile whose condition/procedure carry a document_id FK", () => {
    const admin = createLogin({ role: "admin" });
    const acting = createProfile("Acting Admin");
    const victim = createProfile("Test Patient");
    // A second profile with its own document + child rows, to prove the delete is
    // scoped to the victim and leaves the bystander's clinical subtree intact.
    const bystander = createProfile("Ada Lovelace");
    actAs(admin, acting);

    const victimDoc = addDoc(victim.id);
    // A referencing child in each clinical-list domain ordered AFTER
    // medical_documents in OWNED_TABLES — a condition and a procedure suffice to
    // reproduce the FK abort.
    db.prepare(
      `INSERT INTO conditions (profile_id, name, document_id)
       VALUES (?, 'Hypertension', ?)`
    ).run(victim.id, victimDoc);
    db.prepare(
      `INSERT INTO procedures (profile_id, name, document_id)
       VALUES (?, 'Appendectomy', ?)`
    ).run(victim.id, victimDoc);

    const bystanderDoc = addDoc(bystander.id);
    db.prepare(
      `INSERT INTO conditions (profile_id, name, document_id)
       VALUES (?, 'Asthma', ?)`
    ).run(bystander.id, bystanderDoc);

    return deleteProfile(fd({ id: victim.id })).then((res) => {
      // Pre-fix: this rejects with a generic internal error (FK constraint abort).
      expect(res.ok).toBe(true);

      // Profile and its whole clinical subtree are gone — no orphan rows.
      expect(
        db.prepare("SELECT id FROM profiles WHERE id = ?").get(victim.id)
      ).toBeUndefined();
      const countFor = (table: string, pid: number) =>
        (
          db
            .prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE profile_id = ?`)
            .get(pid) as { c: number }
        ).c;
      expect(countFor("medical_documents", victim.id)).toBe(0);
      expect(countFor("conditions", victim.id)).toBe(0);
      expect(countFor("procedures", victim.id)).toBe(0);

      // The bystander's document + child survive untouched.
      expect(countFor("medical_documents", bystander.id)).toBe(1);
      expect(countFor("conditions", bystander.id)).toBe(1);

      // foreign_keys is restored to ON after the sweep (it must not leak OFF).
      expect(db.pragma("foreign_keys", { simple: true })).toBe(1);
    });
  });
});
