import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 132 (issue #1756): the ACCOUNT-LEVEL run report — where a run that has no
// profile leaves its trace.
//
// ── THE HOLE THIS FILLS ──────────────────────────────────────────────────────
//
// A sync report lands as an ordinary `integration_sync_events` row, which is exactly
// right when the run named a patient allos has a binding for: the run belongs to that
// profile, and the profile's Review, failure badge and "Last checked" all read it.
//
// Two real runs have NO profile at all, and both are the moment trust is being built:
//
//   FIRST CONTACT. The very first run signs in, enumerates the proxy list, and reports
//   it — but its own patient is not bound yet, so the report is refused
//   (`unmapped-identity`) and nothing is recorded about the run. The card then says
//   "No run reported yet." directly underneath its own promise that "the tool reports
//   every run, so a quiet week reads as healthy rather than broken". The promise and the
//   behaviour contradict each other at precisely the wrong moment.
//
//   A PORTAL-LEVEL FAILURE. "The login page changed", "the Document Center moved" — the
//   likely failure mode, and a PRE-PATIENT one. It is a fact about the portal login, not
//   about any one patient, and before this the tool had to fabricate a patient to say it.
//
// ── WHY NOT A NULLABLE profile_id ON integration_sync_events ─────────────────
//
// Because it would buy nothing. Every reader of that table is profile-scoped BY
// CONSTRUCTION — getIntegrationSyncEvents, getLastSuccessfulSyncAt,
// getLatestSyncEventPerProvider (and therefore Data → Review's failure badge),
// getArchiveImportSyncEvents, the retention prune's `GROUP BY profile_id, provider`, and
// deleteProfile's cascade. A NULL-profile row is invisible to all of them, so an
// account-level READER has to exist either way. Meanwhile the rebuild would break the
// invariant that every row of a profile-owned table has a profile, across
// lib/owned-tables.ts, profile deletion, retention and the full export. Full blast
// radius, zero extra visibility.
//
// ── WHY ONE ROW PER LOGIN ────────────────────────────────────────────────────
//
// `account_id` is the PRIMARY KEY, so this table holds "the LAST run this login
// reported" and nothing else. That makes it BOUNDED BY CONSTRUCTION: an authenticated
// tool reporting every five minutes forever rewrites one row per login it can already
// name, so there is no retention sweep to own and no way to grow the table by reporting.
// The append-only history that a profile-bound run deserves already exists — it is
// `integration_sync_events` — and duplicating it here would give the same question two
// answers.
//
// The grain is the LOGIN rather than the portal because that is what the tool actually
// runs as, and because `resolveAccount` already owns the omitted-account rule: a run on a
// single-login portal may omit `account` and resolves anyway; on a multi-login portal it
// must name one and is REFUSED rather than guessed. Storing a portal-wide, account-less
// trace would have needed a second, softer version of that rule — the exact ambiguity the
// account component was added to remove.
//
// ── WHAT IT DOES NOT CARRY ───────────────────────────────────────────────────
//
// No profile_id, and it cannot have one: not being placeable on a profile is what makes a
// run belong here. It is therefore not profile-owned, stays out of lib/owned-tables.ts,
// and needs no profile-scoping allowlist entry. No counts beyond `discovered` either —
// insert/update/unchanged accounting belongs to the profile-bound event, which is the one
// place that can be reconciled against actual rows.
//
// `discovered` is the NEWLY-WAITING count (what `recordDiscoveredIdentities` returns),
// not the length of the reported list — the same honest number the route echoes to the
// tool, so the card and the tool cannot disagree about how much is left to do.
//
// `message` is the tool's own failure line, truncated by the writer. It is free text from
// an authenticated but untrusted tool, so it is rendered as text and never as markup.
//
// House rules (CLAUDE.md): one new table, no rebuild, so there is nothing to null
// beforehand. Self-contained — imports nothing from lib/ — so a replay is decided purely
// by the DB catalog and this file's own constants. Determinism (spec): reads only the DB
// catalog.

export function up(db: Database.Database): void {
  db.exec(
    `CREATE TABLE IF NOT EXISTS portal_run_reports (
       -- One row per portal LOGIN: the last run it reported. PK, so the table is
       -- bounded by the number of logins the household created.
       account_id INTEGER PRIMARY KEY
                  REFERENCES portal_accounts(id) ON DELETE CASCADE,
       portal_id  INTEGER NOT NULL REFERENCES portals(id) ON DELETE CASCADE,
       -- Read through the sqlNow clock seam (#1534) by the writer: the card reduces this
       -- to a calendar day, so it must read the same clock every other day-shaped value
       -- in the app reads.
       at         TEXT NOT NULL,
       ok         INTEGER NOT NULL CHECK (ok IN (0, 1)),
       status     TEXT NOT NULL
                  CHECK (status IN ('downloaded', 'nothing-new', 'failed')),
       message    TEXT,
       -- Newly-waiting identities this run contributed, never the reported list length.
       discovered INTEGER NOT NULL DEFAULT 0,
       -- The same composite FK the other two child tables carry (see migration 131): a
       -- row whose portal_id contradicts its account's portal is UNREPRESENTABLE rather
       -- than merely discouraged.
       FOREIGN KEY (portal_id, account_id)
         REFERENCES portal_accounts(portal_id, id) ON DELETE CASCADE
     )`
  );
  // The card reads every login's last report for one portal at a time.
  db.exec(
    `CREATE INDEX IF NOT EXISTS idx_portal_run_reports_portal
       ON portal_run_reports(portal_id)`
  );
}

export const migration: Migration = {
  id: 132,
  name: "132-portal-run-reports",
  up,
};
