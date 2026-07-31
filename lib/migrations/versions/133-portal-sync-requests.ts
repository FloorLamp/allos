import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 133 (issue #1757): the SYNC REQUEST — a first-class "somebody should run the
// portal tool for this login" — and the one column that lets it reach the right person.
//
// ── WHY A ROW AT ALL ─────────────────────────────────────────────────────────
//
// A portal run needs a PERSON at a specific machine: two-factor codes, sessions that idle
// out in minutes. So the trigger's job is to reach a person, not a machine, and the hard
// part of stale records is REMEMBERING, not the double-click. Knowing a run is due,
// telling the right person, and closing the loop is a notification problem — and a
// notification needs something durable to be about. That is this row.
//
// The three constraints settled in #1739 are structural here, not conventions:
//
//   A REQUEST IS NEVER A SCHEDULE. There is no `run_at`, no cron field, nothing that
//   promises a run happens at a time. The row records that one is WANTED.
//
//   IT EXPIRES RATHER THAN HANGS. `expires_at` is NOT NULL and stamped at creation. A
//   nudge nobody acted on becomes silence, not a permanent badge.
//
//   SLUGS ONLY, NEVER A URL. The row names `(portal_id, account_id)`. There is no
//   address column here, and there is none in `portals` either — allos has never had one
//   to store, and this table does not become the first place it could hide.
//
// ── ONE ROW PER PORTAL LOGIN, BY PRIMARY KEY ─────────────────────────────────
//
// `account_id` is the PRIMARY KEY, exactly as it is in migration 132's run reports, and
// for the same reason: the table is BOUNDED BY CONSTRUCTION. A staleness evaluator
// running hourly forever, a household pressing "Request sync" all afternoon, a busy week
// of appointments — all of them rewrite one row per portal login. No retention sweep to
// own, and no way to grow the table by asking.
//
// It is also the honest grain for the ACTION. What a request asks for is "go run the
// portal tool for this login". That errand is the same errand whether a timer, a visit,
// or a person raised it; two rows would ask one person to do one thing twice. Which
// reason wins when a second arrives is a pure decision (lib/sync-requests.ts:
// shouldWriteSyncRequest — manual > post-visit > staleness, and only a STRICTLY more
// salient reason may replace one that is still open).
//
// ── NO STATE COLUMN, BECAUSE THE REQUEST ANSWERS ITSELF ──────────────────────
//
// There is deliberately no `answered_at`, no `state`, and no claim/acknowledgment field.
// A request for `(ochsner, mom)` is satisfied by the next run report naming that pair,
// and migration 132 already stores that: `portal_run_reports.at`, one row per login,
// moving only forward. So "answered" is the comparison `run_report.at >= created_at`,
// evaluated at READ time.
//
// That is what keeps the tool out of it entirely: no acknowledgment protocol, nothing new
// on the wire, no cleanup burden, and no second write path on the report endpoint that
// could disagree with the first. A stored `answered_at` would need the report route to
// remember to set it, and a route that forgets leaves a household nagged about a sync
// they just ran.
//
// ── NOT PROFILE-OWNED ────────────────────────────────────────────────────────
//
// A request names a portal LOGIN, not a person. It has no `profile_id` and cannot: the
// same request covers every patient bound under that login, and picking one of them to
// own the row would be inventing a subject. It therefore stays out of
// lib/owned-tables.ts and needs no profile-scoping allowlist entry — the same standing
// migrations 131 and 132 gave `pending_portal_identities` and `portal_run_reports`.
//
// ── THE ONE ADDED COLUMN: WHO REPORTED ───────────────────────────────────────
//
// A nudge must reach the login whose token actually runs the tool for this portal login —
// "Mom's phone buzzes about Mom's portal" — and nothing recorded that. Migration 132
// stores the last run per portal login but not WHICH allos login pushed it, so the only
// available audience was "everyone who manages any mapped profile", which is precisely
// the household-wide broadcast this feature exists to avoid.
//
// So `portal_run_reports` grows a nullable `reported_by_login_id`. Nullable because every
// row written before this migration has no answer, and a run reported by a login that is
// later deleted must lose the attribution rather than the run: ON DELETE SET NULL, like
// the identity links in 131 and the document provenance link in 130. When it is null the
// routing falls back to the logins with WRITE access to the mapped profiles, which is the
// audience that could have acted anyway.
//
// House rules (CLAUDE.md): one new table plus one guarded ADD COLUMN — no rebuild, so
// there is nothing to null beforehand. Self-contained (imports nothing from lib/), so a
// replay is decided purely by the DB catalog and this file's own constants. Determinism
// (spec): reads only the DB catalog.

function columnNames(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((c) => c.name);
}

export function up(db: Database.Database): void {
  const run = db.transaction(() => {
    db.exec(
      `CREATE TABLE IF NOT EXISTS portal_sync_requests (
         -- One row per portal LOGIN: the open ask, if there is one. PK, so the table is
         -- bounded by the number of logins the household registered.
         account_id INTEGER PRIMARY KEY
                    REFERENCES portal_accounts(id) ON DELETE CASCADE,
         portal_id  INTEGER NOT NULL REFERENCES portals(id) ON DELETE CASCADE,
         -- WHY the request exists. A closed set, matching SYNC_REQUEST_REASONS in
         -- lib/sync-requests.ts; growing it needs a rebuild migration, which is the
         -- intended friction.
         reason     TEXT NOT NULL
                    CHECK (reason IN ('staleness', 'post-visit', 'manual')),
         -- Both stamps are read through the sqlNow clock seam (#1534) by the writer: the
         -- card reduces them to a calendar day ("expires in 6 days") and the dedupe key
         -- is anchored on the creation DAY, so they must read the same clock every other
         -- day-shaped value in the app reads.
         created_at TEXT NOT NULL,
         -- NOT NULL by design: a request that could omit its deadline would be a request
         -- that hangs, which is the failure #1739 settled against.
         expires_at TEXT NOT NULL,
         -- The same composite FK the other portal child tables carry (migration 131): a
         -- row whose portal_id contradicts its account's portal is UNREPRESENTABLE.
         FOREIGN KEY (portal_id, account_id)
           REFERENCES portal_accounts(portal_id, id) ON DELETE CASCADE
       )`
    );
    // The card and the Upcoming generator both ask "what is open for this portal".
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_portal_sync_requests_portal
         ON portal_sync_requests(portal_id)`
    );

    // ── Which allos login reported a run for this portal login ──
    if (columnNames(db, "portal_run_reports").length > 0) {
      if (
        !columnNames(db, "portal_run_reports").includes("reported_by_login_id")
      ) {
        db.exec(
          `ALTER TABLE portal_run_reports ADD COLUMN reported_by_login_id INTEGER
             REFERENCES logins(id) ON DELETE SET NULL`
        );
      }
    }
  });
  run.immediate();
}

export const migration: Migration = {
  id: 133,
  name: "133-portal-sync-requests",
  up,
};
