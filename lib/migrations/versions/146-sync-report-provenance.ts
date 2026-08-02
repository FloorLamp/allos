import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 146 (issues #1888, #1889): WHAT KIND OF RUN a sync report describes, and
// the per-identity settled answer "the portal declines the download for this person".
//
// ── THE BUG THIS SCHEMA EXISTS FOR (#1888) ───────────────────────────────────
//
// The acquirer's standalone `push` command contacts NO portal at all — it ships records
// already on disk — and still posts a sync report, because that report is also how
// bindings are discovered. The report was indistinguishable from a run report, so a
// delivery ANSWERED an open sync request (`openSyncRequests` projected `lastReportAt`
// from the report stamp unconditionally) and RESET the staleness clock (`lastOkAt` came
// from the same row). Nobody checked the portal, and allos believed someone had — an
// unfalsifiable "we're up to date", which is the one failure this feature cannot have.
//
// ── WHY COLUMNS, NOT A FOURTH STATUS ─────────────────────────────────────────
//
// `status` answers HOW THE RUN WENT (downloaded / nothing-new / failed) and stays the
// closed three-value enum. These columns answer WHAT KIND OF RUN IT WAS, which is
// orthogonal: a delivery can succeed, an unattended run can fail. Growing the status
// enum to say it would touch `isSyncReportStatus`, the `ok` decision, and every reader
// of the enum, to express something the enum is not about.
//
//   contacted — did this report describe a visit to the portal at all. Absent on the
//               wire means TRUE, so every existing client keeps its exact meaning and
//               every existing row is a contact (see the backfill below).
//   attended  — was a PERSON at the machine. Also absent-means-true. A scheduled,
//               unattended run that FAILS has had nobody act on it, so it must not
//               answer the request that asked a person to go and act (#1889).
//
// ── THE TWO CLOCK COLUMNS, AND WHY THE FLAGS ALONE ARE NOT ENOUGH ────────────
//
// `portal_run_reports` holds ONE ROW PER LOGIN — the last run it reported — which is
// what makes the table bounded by construction (migration 132). So a delivery-only push
// OVERWRITES the previous genuine run's stamp. Filtering `rr.contacted = 1` at read time
// would therefore turn "checked yesterday, pushed today" into "never checked", and raise
// a staleness nudge one day after a real run: the opposite bug, equally silent.
//
// So the CHECK CLOCK is sticky and lives in its own columns, stamped by
// recordPortalRunReport through the ONE pure predicate pair in lib/acquirer-identity.ts
// (`reportAnswersRequest` / `reportAdvancesStalenessClock`, both derived from
// `reportCountsAsCheck`). Every consumer then reads a column instead of restating the
// predicate in SQL — the two-hand-written-predicates shape that produced #1888:
//
//   checked_at    — the last report that ANSWERS an open sync request: contacted, and
//                   either successful or attended.
//   checked_ok_at — the last report that advances the STALENESS clock: contacted and
//                   successful. A subset of checked_at by construction.
//
// ── THE ESCALATION CLAUSE (#1889) ────────────────────────────────────────────
//
// A failed unattended run leaves the request OPEN — and is exactly the information the
// person-channel copy wants ("the scheduled run couldn't sign in — someone needs to go
// to the machine"). It is sticky for the same reason the clock is: an unrelated delivery
// push must not erase why the machine gave up. Any report that answers the request
// clears it, so it is state-driven and self-clearing rather than a queue.
//
// ── PER-IDENTITY `declined` (#1889's owner ruling) ───────────────────────────
//
// A run collects for every patient a login can reach, and one login covering three
// people routinely gets one download and two refusals ON THE SAME RUN. A run-level flag
// (or a fourth status) cannot express that, so the standing answer lives on the
// IDENTITY — the sibling of `ignored`, which is the existing settled-answer shape.
//
// DELIBERATELY NOT `ignored`'s CHECK. Migration 131 makes `ignored` and "has a profile"
// mutually exclusive, because an ignored label names nobody here. A DECLINED identity is
// the opposite: it is bound to a real profile, the household wants those records, and
// the portal simply will not hand them over. So it carries a profile, and no CHECK
// couples the two columns.
//
// House rules (CLAUDE.md): new columns on existing tables get a new migration, no
// rebuild. `portal_identities` is already profile-owned and already in
// lib/owned-tables.ts; `portal_run_reports` carries no profile_id and never will.
// Self-contained — imports nothing from lib/ — so a replay is decided purely by the DB
// catalog, and each ADD is guarded by its own column check.

function columns(db: Database.Database, table: string): Set<string> {
  return new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map(
      (c) => c.name
    )
  );
}

export function up(db: Database.Database): void {
  const run = db.transaction(() => {
    const reports = columns(db, "portal_run_reports");
    if (reports.size > 0) {
      // Absent on the wire means TRUE, so the stored default IS the old meaning and
      // every row written by a client that has never heard of these fields is honest.
      if (!reports.has("contacted")) {
        db.exec(
          `ALTER TABLE portal_run_reports
             ADD COLUMN contacted INTEGER NOT NULL DEFAULT 1
             CHECK (contacted IN (0, 1))`
        );
      }
      if (!reports.has("attended")) {
        db.exec(
          `ALTER TABLE portal_run_reports
             ADD COLUMN attended INTEGER NOT NULL DEFAULT 1
             CHECK (attended IN (0, 1))`
        );
      }
      // The sticky check clock. NULL means "never" for both, which is exactly what
      // isStalenessDue already treats as the clearest case of records not flowing.
      if (!reports.has("checked_at")) {
        db.exec(`ALTER TABLE portal_run_reports ADD COLUMN checked_at TEXT`);
      }
      if (!reports.has("checked_ok_at")) {
        db.exec(`ALTER TABLE portal_run_reports ADD COLUMN checked_ok_at TEXT`);
      }
      // The last unattended failure, until a report answers the request.
      if (!reports.has("unattended_fail_at")) {
        db.exec(
          `ALTER TABLE portal_run_reports ADD COLUMN unattended_fail_at TEXT`
        );
      }
      if (!reports.has("unattended_fail_message")) {
        db.exec(
          `ALTER TABLE portal_run_reports ADD COLUMN unattended_fail_message TEXT`
        );
      }
      // BACKFILL, one-shot and here rather than in a settings flag: every existing row
      // was written by a client with no way to say otherwise, so every existing row is a
      // contact. Seeding the clock from the stamps the old readers used keeps the
      // migration behaviour-preserving — a household that upgrades mid-week does not
      // suddenly read as never-checked. Guarded on the sticky column being unset so a
      // replay cannot walk a live clock backwards.
      db.exec(
        `UPDATE portal_run_reports
            SET checked_at = at,
                checked_ok_at = CASE WHEN ok = 1 THEN at END
          WHERE checked_at IS NULL AND checked_ok_at IS NULL`
      );
    }

    const identities = columns(db, "portal_identities");
    if (identities.size > 0 && !identities.has("declined")) {
      // The portal refuses the download for this identity. Standing state, not an event:
      // it is re-asserted by every run that meets it and cleared by the first successful
      // collection, so nothing has to remember to tidy it up.
      db.exec(
        `ALTER TABLE portal_identities
           ADD COLUMN declined INTEGER NOT NULL DEFAULT 0
           CHECK (declined IN (0, 1))`
      );
    }
  });
  run.immediate();
}

export const migration: Migration = {
  id: 146,
  name: "146-sync-report-provenance",
  up,
};
