// Part of the lib/queries/intake barrel (#319), split out of adherence.ts under
// #2960 / rule #5670. The profile-scoping guard walks all of lib/, so this module
// stays covered; every read is profile-scoped directly or through the parent
// intake_items JOIN.
//
// THE UNDOABLE ADMINISTRATION DELETE (#851 item 11) — the one pair of writes that
// takes a ledger row OUT and puts it BACK. It is its own module because deleting a
// dose is not the inverse of any door that creates one: the create paths differ
// (scheduled confirm, PRN tap, historical backfill) but all of them are undone here,
// through one capture into `deleted_rows` and one restore off that capture.
//
// Every side effect has to invert (the row-ops discipline). Window and daily count are
// DERIVED from the ledger rows, so removing the row recomputes them for free; supply is
// the one STORED effect, so it is credited back on delete and re-applied on restore.
// The restore re-inserts under a NEW id, which is why the notify one-shot marker
// (id-keyed, never recycled) is left alone as a harmless dead reference.
//
// The no-rearm rule is imported rather than restated: a delete un-marks the dose for
// its day, so the day it vacated is stamped handled and can never be chased.
import { suppressEscalationRearm } from "./no-rearm";
import { db, writeTx } from "../../db";
import { decrementSupply, incrementSupply } from "./refill";

// ---- Undoable medication administration delete (issue #851 item 11) ----
//
// A fat-fingered PRN Log tap is otherwise PERMANENT and NOT cosmetic: the phantom
// administration decremented on-hand supply, ADVANCED the redose window (the next real
// dose shows "wait 6h" off a dose never given — a safety-relevant inversion), and
// counted toward the daily max. Removing it must invert EVERY side effect (the row-ops
// discipline). Because the window/count are DERIVED from the ledger rows (see
// prn-redose.ts / med-data.ts), deleting the row auto-recomputes them — the only stored
// side effect to invert is supply. The notify one-shot marker (notify_last_redose_*) is
// id-keyed and never recycles, so a stale marker after a delete is a harmless dead ref.
//
// Kind 'administration' in deleted_rows (the shared retention-purged holding table);
// restore
// re-inserts the ledger row (NEW id) and RE-decrements supply. The undo toast +
// undoDelete action route restore back here via restoreDeletedRow's kind branch.

// The captured shape of one administration row (the deleted_rows payload for kind
// 'administration'). item_id + the log's own columns, enough to re-insert it verbatim.
interface CapturedAdministration {
  dose_id: number;
  item_id: number;
  date: string;
  occurred_at: string | null;
  recorded_at: string;
  amount: string | null;
  product: string | null;
  status: string;
  supply_adjusted: number;
  /**
   * The surface the row was ORIGINALLY logged from (#3087), carried through the undo
   * holding store so a restore puts back the row that existed rather than minting a
   * new provenance for it. `null` for a row created before the column existed, and
   * for a token captured by an older build — both of which are honestly unknown.
   */
  logged_via: string | null;
  /**
   * The composed action the row was written by (#4328), carried for the same reason
   * `logged_via` is: a restore puts back the row that existed, so a member restored
   * into its stack rejoins the stack rather than standing alone beside it. `null` for
   * a row written one tap at a time, and for a token captured by an older build.
   */
  bundle_id: string | null;
}

// Delete one taken administration (an intake_item_logs row) with capture-for-undo, and
// invert its supply decrement only when that row originally changed supply. Auth-blind,
// profileId-first. Ownership is verified via the parent item's profile_id (the ledger
// has no profile_id column). Returns the undo token (deleted_rows id) or null when the
// row isn't the profile's / is gone. One IMMEDIATE transaction so the capture + delete
// + any supply re-credit commit together.
//
// Kind-neutral since #1933 (`s.kind = 'medication'` is gone from the ownership SELECT);
// a retired dose or a paused item is no bar, because the row being removed is history,
// not schedule. The supply re-credit is the counter-like half: it runs through the
// shared incrementSupply, so a pooled item (#1374) hands the units back to the
// household bottle rather than to a private counter it doesn't keep — and it is the
// exact inverse of the decrement restoreAdministrationLog re-applies.
// What a successful delete removed: the undo token plus the identifiers the action
// boundary audits the correction by (#1933). Never the amount, product, or name — an
// audit row records that history changed and for which item/date, not the content.
export interface AdministrationDeleteOutcome {
  undoId: number;
  itemId: number;
  date: string;
}

export function deleteAdministrationLog(
  profileId: number,
  logId: number
): AdministrationDeleteOutcome | null {
  return writeTx((): AdministrationDeleteOutcome | null => {
    const row = db
      .prepare(
        `SELECT l.id, l.dose_id, l.item_id, l.date, l.occurred_at, l.recorded_at,
                l.amount, l.product, l.status, l.supply_adjusted, l.logged_via,
                l.bundle_id
           FROM intake_item_logs l
           JOIN intake_items s ON s.id = l.item_id
          WHERE l.id = ? AND s.profile_id = ?
            AND l.status = 'taken'`
      )
      .get(logId, profileId) as
      (CapturedAdministration & { id: number }) | undefined;
    if (!row) return null;

    const captured: CapturedAdministration = {
      dose_id: row.dose_id,
      item_id: row.item_id,
      date: row.date,
      occurred_at: row.occurred_at,
      recorded_at: row.recorded_at,
      amount: row.amount,
      product: row.product,
      status: row.status,
      supply_adjusted: row.supply_adjusted,
      logged_via: row.logged_via,
      bundle_id: row.bundle_id,
    };
    const info = db
      .prepare(
        `INSERT INTO deleted_rows (profile_id, kind, label, payload)
         VALUES (?, 'administration', 'administration', ?)`
      )
      .run(profileId, JSON.stringify({ administration: captured }));

    // Scoped at the DELETE too (#2059), not only at the SELECT that captured the row:
    // an undo is the one write here that destroys a record of something taken, so it is
    // the last statement that should depend on a sibling query staying correct.
    db.prepare(
      `DELETE FROM intake_item_logs
        WHERE id = ? AND item_id IN (
          SELECT id FROM intake_items WHERE profile_id = ?
        )`
    ).run(logId, profileId);
    // Invert the supply decrement the administration applied (a 'taken' row consumed
    // supply). incrementSupply is a no-op when quantity_on_hand IS NULL (untracked).
    if (row.status === "taken" && row.supply_adjusted === 1) {
      incrementSupply(profileId, row.item_id);
    }
    // The dose is now unconfirmed for the day this row covered — stamp that day handled
    // so removing a mis-tap can never resurrect its missed-dose escalation.
    suppressEscalationRearm(profileId, row.dose_id, row.date);
    return {
      undoId: Number(info.lastInsertRowid),
      itemId: row.item_id,
      date: row.date,
    };
  });
}

// Restore a captured medication administration from its undo token (routed here by
// restoreDeletedRow's kind branch). Re-inserts the ledger row (NEW id) and RE-applies
// the supply decrement (the inverse of the delete's re-credit), then drops the holding
// row — all in one IMMEDIATE transaction. Returns false when the token is gone (already
// restored / swept / another profile's) or the parent dose no longer exists (the med
// was deleted since), so a stale undo can't resurrect a dangling ledger row.
export function restoreAdministrationLog(
  profileId: number,
  undoId: number
): boolean {
  return writeTx((): boolean => {
    const holding = db
      .prepare(
        `SELECT payload FROM deleted_rows
          WHERE id = ? AND profile_id = ? AND kind = 'administration'`
      )
      .get(undoId, profileId) as { payload: string } | undefined;
    if (!holding) return false;

    let captured: CapturedAdministration;
    try {
      captured = (JSON.parse(holding.payload) as { administration: unknown })
        .administration as CapturedAdministration;
    } catch {
      return false;
    }
    // The parent dose must still exist and belong to this profile (the med may have
    // been deleted since the capture — its ledger rows would have cascaded away).
    const dose = db
      .prepare(
        `SELECT 1 FROM intake_item_doses d
           JOIN intake_items s ON s.id = d.item_id
          WHERE d.id = ? AND d.item_id = ? AND s.profile_id = ?`
      )
      .get(captured.dose_id, captured.item_id, profileId);
    if (!dose) return false;

    // Undo tokens captured before the supply flag was introduced represent ordinary
    // logs, all of which consumed supply. Default those legacy payloads to 1.
    const supplyAdjusted = captured.supply_adjusted ?? 1;
    db.prepare(
      `INSERT INTO intake_item_logs
         (dose_id, item_id, date, occurred_at, recorded_at, amount, product, status,
          supply_adjusted, logged_via, bundle_id)
       VALUES (?,?,?,?,?,?,?,?,?,?,?)`
    ).run(
      captured.dose_id,
      captured.item_id,
      captured.date,
      captured.occurred_at,
      captured.recorded_at,
      captured.amount,
      captured.product ?? null,
      captured.status,
      supplyAdjusted,
      // RESTORED, not re-created: an undo puts back the row that was deleted, so it
      // carries the provenance it was born with. A pre-column token has `undefined`
      // here and restores NULL, which is the honest answer rather than a guess.
      captured.logged_via ?? null,
      captured.bundle_id ?? null
    );
    if (captured.status === "taken" && supplyAdjusted === 1) {
      decrementSupply(profileId, captured.item_id);
    }
    db.prepare(`DELETE FROM deleted_rows WHERE id = ? AND profile_id = ?`).run(
      undoId,
      profileId
    );
    return true;
  });
}
