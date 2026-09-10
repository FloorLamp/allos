// SERVER-ACTION TIER — the dose-history delete's UNDO half, across profiles (#4844).
//
// `DoseHistoryPanel`'s ⋯ Delete posts the panel's `subjectProfileId` and runs
// `deleteAdministration`, whose gate (gateItemProfile → requireProfileWriteAccess) is
// already pinned by the record's correction table in
// history-cross-profile-correction.actions.test.ts — both refusals and the permitting
// arm, each asserted on the victim's own row. What that table does NOT reach is the
// SECOND authorization the same tap arms: the delete hands back an `{ undoId }` the
// toast will replay through `undoDelete`, and that replay is gated on a profile
// nobody posts — `deletedRowProfile(undoId)`, resolved from the HOLDING ROW the
// delete stamped (#2104).
//
// So this file's subject is the STAMP and the gate that reads it, for the dose door:
//
//   1. A cross-profile delete captures under the SUBJECT, not under the caregiver who
//      tapped. Stamping the acting profile instead is not a cosmetic slip — the undo's
//      whole authorization is that column, so a capture stamped "Dad" is a token any
//      login that may write Dad can replay, including one with no reach into the child
//      at all. That is the case below that would come back green on a mis-stamp.
//   2. The replay is refused for a login that may NOT write the captured profile, and
//      the refusal is asserted as the administration STILL BEING GONE and the capture
//      still held — not as the promise rejecting. `undoDelete` gating AFTER
//      `restoreDeletedRow` throws exactly the same way while the row is back.
//   3. The rightful caregiver's undo still restores it, onto the SUBJECT — the
//      permitting arm, without which every assertion here is satisfied by an
//      `undoDelete` that refuses everyone.
//
// Every token below is a REAL one the real delete just minted for the profile named,
// so nothing but the gate can produce the refusal: a forged or stale id resolves to no
// owner at all and answers `{ ok: false }` without ever reaching a gate.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { logMedicationAdministration } from "@/app/(app)/medications/actions";
import { deleteAdministration } from "@/app/(app)/nutrition/intake-actions";
import { undoDelete } from "@/app/(app)/undo-actions";
import { createLogin, createProfile, actAs, fd } from "./harness";
import type { TestLogin, TestProfile } from "./harness";

// A PRN medication owned by `profileId`, with tracked supply — the counter that moves
// in the opposite direction to the ledger row, so "restored" is two witnesses, not one.
function seedPrnMed(profileId: number, onHand = 20): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, obligation, quantity_on_hand, qty_per_dose)
         VALUES (?, 'Ibuprofen', 1, 'medication', 'daily', 'may', ?, 1)`
      )
      .run(profileId, onHand).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '200 mg', NULL, 'any', 0)`
  ).run(itemId);
  return itemId;
}

/** Taken administrations on an item — the victim's rows, which is what every claim reads. */
function adminCount(itemId: number): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM intake_item_logs WHERE item_id = ? AND status = 'taken'"
      )
      .get(itemId) as { n: number }
  ).n;
}

function onHand(itemId: number): number | null {
  return (
    db
      .prepare("SELECT quantity_on_hand AS q FROM intake_items WHERE id = ?")
      .get(itemId) as { q: number | null }
  ).q;
}

/** The profile column on the holding row — the one the undo authorizes against. */
function capturedProfile(undoId: number): number | null {
  return (
    (
      db
        .prepare("SELECT profile_id FROM deleted_rows WHERE id = ?")
        .get(undoId) as { profile_id: number } | undefined
    )?.profile_id ?? null
  );
}

function captureHeld(undoId: number): boolean {
  return (
    db.prepare("SELECT 1 FROM deleted_rows WHERE id = ?").get(undoId) != null
  );
}

/**
 * A caregiver login acting as its OWN base profile with a write grant on `kid` — a
 * member, not an admin, because an admin reaches every profile and would prove nothing.
 */
function caregiver(): {
  login: TestLogin;
  home: TestProfile;
  kid: TestProfile;
} {
  const login = createLogin({ role: "member" });
  const home = createProfile("Caregiver Home", login.id);
  const kid = createProfile("Sick Kid", login.id);
  actAs(login, home);
  return { login, home, kid };
}

/**
 * One administration logged on the kid and then deleted from the panel exactly as the
 * ⋯ posts it — `log_id` plus the panel's `subjectProfileId`. Returns the item, the
 * token, and the caregiver, with the ledger row already gone and supply re-credited.
 */
async function deletedCrossProfileDose() {
  const { login, home, kid } = caregiver();
  const itemId = seedPrnMed(kid.id, 20);

  const logged = await logMedicationAdministration(
    fd({ id: itemId, offset: "now", profileId: kid.id })
  );
  expect(logged.ok).toBe(true);
  expect(adminCount(itemId)).toBe(1);
  expect(onHand(itemId)).toBe(19);

  const logId = Number(
    (
      db
        .prepare(
          "SELECT id FROM intake_item_logs WHERE item_id = ? AND status = 'taken' ORDER BY id DESC LIMIT 1"
        )
        .get(itemId) as { id: number }
    ).id
  );
  const { undoId } = await deleteAdministration(
    fd({ log_id: logId, profile_id: kid.id })
  );
  expect(undoId).not.toBeNull();
  expect(adminCount(itemId)).toBe(0);
  expect(onHand(itemId)).toBe(20);

  return { login, home, kid, itemId, undoId: undoId! };
}

describe("the dose-history delete's undo is gated on the CAPTURE's profile (#4844)", () => {
  it("stamps the capture with the SUBJECT the delete was gated on, not the caregiver", async () => {
    const { kid, undoId } = await deletedCrossProfileDose();

    // The whole authorization of the replay is this one column, and the caregiver who
    // tapped is the value it would hold on the mis-stamp — which is why the assertion
    // is the exact subject and not merely "some profile".
    expect(capturedProfile(undoId)).toBe(kid.id);
  });

  it("refuses the replay for a login that may not write the captured profile, restoring nothing", async () => {
    const { itemId, home, undoId } = await deletedCrossProfileDose();

    // A SECOND member with genuine write access to the caregiver's OWN profile and no
    // reach into the child at all. It is granted `home` deliberately: on a capture
    // mis-stamped with the acting profile this login passes the gate and resurrects a
    // child's dose it cannot even read, and every "it threw" assertion stays green.
    const outsiderLogin = createLogin({ role: "member" });
    db.prepare(
      "INSERT OR IGNORE INTO login_profiles (login_id, profile_id) VALUES (?, ?)"
    ).run(outsiderLogin.id, home.id);
    actAs(outsiderLogin, home);

    await expect(undoDelete(undoId)).rejects.toThrow(
      /not accessible|read-only/
    );
    // THE VICTIM'S ROWS, not the fact of a refusal: a gate that ran after
    // restoreDeletedRow would throw here just the same with the dose back on the
    // record and its supply decremented again.
    expect(adminCount(itemId)).toBe(0);
    expect(onHand(itemId)).toBe(20);
    // And the token survives for the owner it belongs to — a consumed capture is
    // silent data loss, since the retention sweep purges it next.
    expect(captureHeld(undoId)).toBe(true);
  });

  it("refuses the replay on a READ-ONLY grant over the captured profile", async () => {
    const { itemId, kid, home, undoId } = await deletedCrossProfileDose();

    // Reach without write — the position that separates "can see the child" from "may
    // change the child's record", and the one a reachability-only gate lets through.
    const readerLogin = createLogin({ role: "member" });
    db.prepare(
      "INSERT OR IGNORE INTO login_profiles (login_id, profile_id) VALUES (?, ?)"
    ).run(readerLogin.id, home.id);
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'read')"
    ).run(readerLogin.id, kid.id);
    actAs(readerLogin, home);

    await expect(undoDelete(undoId)).rejects.toThrow(/read-only/);
    expect(adminCount(itemId)).toBe(0);
    expect(onHand(itemId)).toBe(20);
    expect(captureHeld(undoId)).toBe(true);
  });

  it("restores onto the SUBJECT for the caregiver who deleted it", async () => {
    const { login, home, itemId, undoId } = await deletedCrossProfileDose();
    actAs(login, home);

    // THE PERMITTING ARM. Without it every refusal above is equally satisfied by an
    // `undoDelete` that refuses everyone — which is not a gate, it is the toast's Undo
    // being broken shut, and the delete becoming unrecoverable for the person who
    // owns it.
    // The two counters that moved on the delete both move back, and `itemId` is the
    // CHILD's item — so "restored" here is restored onto the subject, not a row filed
    // on the caregiver.
    expect(await undoDelete(undoId)).toEqual({ ok: true });
    expect(adminCount(itemId)).toBe(1);
    expect(onHand(itemId)).toBe(19);
    expect(captureHeld(undoId)).toBe(false);
  });
});
