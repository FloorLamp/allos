import type Database from "better-sqlite3";
import type { Migration } from "../runner";

// Migration 131 (issue #1739, re-specced): the THIRD identity — a portal ACCOUNT — and
// the three-part `(portal, account, patient_label) → profile` mapping it makes possible.
//
// ── WHY A TWO-PART KEY IS WRONG ──────────────────────────────────────────────
//
// Migration 128 keyed the mapping `(portal_id, patient_label)`, on the assumption that a
// patient label identifies a person within a portal. It does not. One portal commonly has
// SEVERAL LOGINS in a household — each parent holds their own account, with overlapping
// proxy access — and a portal's proxy list is rendered PER LOGIN. Father's account can
// show "SMITH, ALEX" meaning himself while mother's shows a different "SMITH, ALEX"
// meaning a Jr. Under the two-part key those two collapse into ONE binding, and one of
// the two people's records land on the other's profile. That is the exact harm this
// entire surface exists to prevent, so the key grows a component rather than the resolver
// growing a heuristic.
//
// ── WHAT AN ACCOUNT IS, AND IS NOT ───────────────────────────────────────────
//
// An account is a HOUSEHOLD NICKNAME for "which portal login": "Mom", "Dad". Like a
// portal it is allos-minted — a stable slug plus a display name, so a rename never
// invalidates the key a tool's local config references.
//
// It is emphatically NOT:
//
//   NOT THE PORTAL USERNAME. That is half a credential and never crosses to allos.
//     Username, password, saved session and device trust live ONLY in the tool's local
//     config on the user's machine, keyed by this slug. Nothing here is a credential, so
//     a database leak yields nicknames.
//
//   NOT DISCOVERED. Patient labels come from the portal's proxy list and the tool reports
//     them verbatim; the ACCOUNT label is the one identity the USER mints, because only
//     they know which login is whose. A tool cannot name it for them.
//
//   NOT GLOBALLY UNIQUE. It is scoped to its portal: "Mom" under `ochsner` and "Mom"
//     under `baptist` are unrelated rows. Hence UNIQUE(portal_id, slug), not UNIQUE(slug).
//
// THE IMPLICIT ACCOUNT. The single-login household — which is most of them — must not
// have to learn this concept. Every portal gets one implicit account created with it
// (`implicit = 1`), and every binding names an account from birth, so the third component
// is invisible on the wire until a second login exists. The WIRE may omit `account`; the
// STORAGE never does. `lib/portals.ts::resolveAccount` owns the omitted-account rule and
// documents it: exactly one account on the portal resolves it, and MORE than one refuses
// typed rather than picking. An omitted account must never silently choose among
// alternatives — that would reintroduce misfiling through the very door this migration
// closes.
//
// ── THE COMPOSITE FOREIGN KEY (portal_id, account_id) ────────────────────────
//
// `portal_identities` keeps `portal_id` alongside `account_id` — the spec's key is
// three-part and the reads are portal-shaped — which normally invites the classic
// denormalization bug: a row whose portal_id contradicts its account's portal. That is
// not left to discipline here. `portal_accounts` carries a UNIQUE(portal_id, id) index
// purely so the child tables can declare
//
//     FOREIGN KEY (portal_id, account_id) REFERENCES portal_accounts(portal_id, id)
//
// which makes the contradiction UNREPRESENTABLE rather than merely discouraged. Same for
// pending_portal_identities.
//
// ── IGNORED BINDINGS ─────────────────────────────────────────────────────────
//
// A household may have a patient on a portal it simply does not want synced — a relative
// whose records belong somewhere else. Refusing it forever is right, but it would sit in
// the pending list forever too, and a permanent unfixable warning trains people to ignore
// warnings. So a binding may be IGNORED: `ignored = 1` with NO profile.
//
// `profile_id` therefore becomes NULLABLE, and the invariant that keeps resolution honest
// is a CHECK rather than a convention:
//
//     (ignored = 0 AND profile_id IS NOT NULL) OR (ignored = 1 AND profile_id IS NULL)
//
// An ignored row cannot carry a profile to leak, and a live binding cannot lose its
// profile. Resolution requires `ignored = 0`, so an ignored identity answers the SAME
// typed `unmapped-identity` refusal an unknown one does — the endpoint is deliberately
// NON-ORACULAR: a tool cannot distinguish "declined" from "never seen", so the refusal
// reveals nothing about a household's choices to whoever holds the token.
//
// ── PENDING IDENTITIES, THREE-PART FROM BIRTH ────────────────────────────────
//
// `pending_portal_identities` is created here rather than grown from a two-part
// ancestor: it never shipped, so it starts correct. It records what the acquirer surface
// could not place — a refused upload, a refused run report, or (the routine path) an
// identity the tool DISCOVERED and reported in its sync report before anything was ever
// pushed for it. That third value is what makes mapping discovery-driven: the user binds
// labels allos already learned verbatim, instead of predicting how a portal renders a
// name. It has NO profile_id and cannot have one — not being placeable on a profile is
// what makes it pending — so it is not profile-owned and stays out of
// lib/owned-tables.ts.
//
// ── PER-IDENTITY SYNC EVENTS ─────────────────────────────────────────────────
//
// `integration_sync_events` gains three NULLABLE identity columns. The card must show
// "Last synced" per (portal, account, patient) — a household with two portals and three
// patients has six answers to that question, and one row per profile cannot hold them.
// Nullable because every other provider's events have no identity, and so do this
// provider's `profile=<id>` reports.
//
// House rules (CLAUDE.md): the ONE table rebuild here nulls/removes dangling links first
// (see rebuildPortalIdentities), runs with foreign_keys off as the runner guarantees, and
// recreates every index. New tables and guarded ADD COLUMNs otherwise. Self-contained —
// imports nothing from lib/ — so a replay is decided purely by the DB catalog and this
// file's own constants. Determinism (spec): reads only the DB catalog.

function columnNames(db: Database.Database, table: string): string[] {
  return (
    db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]
  ).map((c) => c.name);
}

function hasTable(db: Database.Database, table: string): boolean {
  return (
    db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
      .get(table) != null
  );
}

// The implicit account every portal gets, so a single-login household never meets the
// concept. Kept as constants here (not imported) so a replay is decided by this file.
const IMPLICIT_SLUG = "default";
const IMPLICIT_NAME = "Default login";

const PORTAL_IDENTITIES_CREATE = `
  CREATE TABLE portal_identities (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    portal_id     INTEGER NOT NULL REFERENCES portals(id) ON DELETE CASCADE,
    account_id    INTEGER NOT NULL REFERENCES portal_accounts(id) ON DELETE CASCADE,
    patient_label TEXT NOT NULL,
    profile_id    INTEGER REFERENCES profiles(id) ON DELETE CASCADE,
    ignored       INTEGER NOT NULL DEFAULT 0,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (
      (ignored = 0 AND profile_id IS NOT NULL) OR
      (ignored = 1 AND profile_id IS NULL)
    ),
    FOREIGN KEY (portal_id, account_id)
      REFERENCES portal_accounts(portal_id, id) ON DELETE CASCADE
  )`;

const PORTAL_IDENTITIES_INDEXES = [
  // One label on one LOGIN of one portal resolves to exactly one answer. Case-SENSITIVE
  // by design: two visibly different labels are two different people.
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_identities_key
     ON portal_identities(portal_id, account_id, patient_label)`,
  // The card lists a profile's bindings, and deleteProfile clears by profile_id.
  `CREATE INDEX IF NOT EXISTS idx_portal_identities_profile
     ON portal_identities(profile_id)`,
  `CREATE INDEX IF NOT EXISTS idx_portal_identities_account
     ON portal_identities(account_id)`,
];

function rebuildPortalIdentities(db: Database.Database): void {
  const cols = new Set(columnNames(db, "portal_identities"));
  if (cols.size === 0) return; // partial handle — nothing to converge
  if (cols.has("account_id")) return; // already three-part — replay no-op

  // DANGLING LINKS FIRST (the house rule). `account_id` and the CHECK are both NOT-NULL-
  // shaped, so a row that cannot be given an account, or that carries a profile that no
  // longer exists, cannot survive the rebuild. Both are already-broken rows rather than
  // data being discarded: resolvePortalIdentity JOINs `portals`, so a binding naming a
  // vanished portal has never been able to resolve, and a binding naming a vanished
  // profile would resolve an upload onto a profile that is not there — the misfiling this
  // table exists to prevent. deleteProfile/deletePortal already remove these rows in the
  // normal course; this only catches what a foreign_keys-off window left behind.
  db.exec(
    `DELETE FROM portal_identities
       WHERE portal_id NOT IN (SELECT id FROM portals)
          OR profile_id NOT IN (SELECT id FROM profiles);`
  );

  const scratch = "portal_identities__new131";
  db.exec(
    PORTAL_IDENTITIES_CREATE.replace(
      "CREATE TABLE portal_identities (",
      `CREATE TABLE ${scratch} (`
    )
  );
  // Every surviving binding belongs to its portal's IMPLICIT account: before this
  // migration a portal had exactly one login as far as allos knew, so that is precisely
  // what these rows meant. `ignored` starts 0 for all of them — nothing was ignorable
  // before — and the CHECK holds because every carried row has a profile.
  db.exec(
    `INSERT INTO ${scratch}
       (id, portal_id, account_id, patient_label, profile_id, ignored, created_at, updated_at)
     SELECT pi.id, pi.portal_id, pa.id, pi.patient_label, pi.profile_id, 0,
            pi.created_at, pi.updated_at
       FROM portal_identities pi
       JOIN portal_accounts pa
         ON pa.portal_id = pi.portal_id AND pa.implicit = 1;`
  );
  db.exec(`DROP TABLE portal_identities;`);
  db.exec(`ALTER TABLE ${scratch} RENAME TO portal_identities;`);
  for (const idx of PORTAL_IDENTITIES_INDEXES) db.exec(idx);
}

export function up(db: Database.Database): void {
  // Wrapped in one (possibly nested) transaction for atomicity; the runner applies
  // migrations with foreign_keys disabled (issue #95), which is what lets the rebuild
  // below drop its table without cascading its children away.
  const run = db.transaction(() => {
    // ── Portals gain an optional software tag ──
    //
    // For display, and so a tool can sanity-check what it has been pointed at: a config
    // that says `ochsner` is a MyChart portal, landing on a Cerner login page, is a
    // misconfiguration worth catching on the tool side. Deliberately NOT an address and
    // not a version — a coarse family name. CHECK-constrained to the known families so an
    // unknown value can never be persisted; growing it needs a rebuild migration, which
    // is the intended friction.
    if (
      hasTable(db, "portals") &&
      !columnNames(db, "portals").includes("software")
    ) {
      db.exec(
        `ALTER TABLE portals ADD COLUMN software TEXT
           CHECK (software IS NULL OR software IN ('mychart','cerner','generic-ccd'))`
      );
    }

    // ── Accounts ──
    db.exec(
      `CREATE TABLE IF NOT EXISTS portal_accounts (
         id         INTEGER PRIMARY KEY AUTOINCREMENT,
         portal_id  INTEGER NOT NULL REFERENCES portals(id) ON DELETE CASCADE,
         slug       TEXT NOT NULL,
         name       TEXT NOT NULL,
         implicit   INTEGER NOT NULL DEFAULT 0,
         created_at TEXT NOT NULL DEFAULT (datetime('now'))
       )`
    );
    // Scoped to its portal, not global: "Mom" under two portals is two unrelated logins.
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_accounts_key
         ON portal_accounts(portal_id, slug COLLATE NOCASE)`
    );
    // The parent index for the composite FK on the two child tables — see the header.
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_portal_accounts_portal_id
         ON portal_accounts(portal_id, id)`
    );

    // Every EXISTING portal gets its implicit account, before the rebuild reads it.
    if (hasTable(db, "portals")) {
      db.prepare(
        `INSERT INTO portal_accounts (portal_id, slug, name, implicit, created_at)
         SELECT p.id, ?, ?, 1, datetime('now')
           FROM portals p
          WHERE NOT EXISTS (
                SELECT 1 FROM portal_accounts a WHERE a.portal_id = p.id
              )`
      ).run(IMPLICIT_SLUG, IMPLICIT_NAME);
    }

    // ── The mapping, re-keyed ──
    rebuildPortalIdentities(db);

    // ── Refused / discovered identities, three-part from birth ──
    db.exec(
      `CREATE TABLE IF NOT EXISTS pending_portal_identities (
         id            INTEGER PRIMARY KEY AUTOINCREMENT,
         portal_id     INTEGER NOT NULL REFERENCES portals(id) ON DELETE CASCADE,
         account_id    INTEGER NOT NULL REFERENCES portal_accounts(id) ON DELETE CASCADE,
         patient_label TEXT NOT NULL,
         first_seen_at TEXT NOT NULL DEFAULT (datetime('now')),
         last_seen_at  TEXT NOT NULL DEFAULT (datetime('now')),
         seen_count    INTEGER NOT NULL DEFAULT 1,
         last_outcome  TEXT NOT NULL
           CHECK(last_outcome IN ('discovered','unmapped-upload','unmapped-sync-report')),
         FOREIGN KEY (portal_id, account_id)
           REFERENCES portal_accounts(portal_id, id) ON DELETE CASCADE
       )`
    );
    // The identity IS the key — a tool reporting the same discovered list every run bumps
    // one row rather than growing the table.
    db.exec(
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_portal_identities_key
         ON pending_portal_identities(portal_id, account_id, patient_label)`
    );
    // The per-account cap evicts by least-recently-seen within an account.
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_pending_portal_identities_account
         ON pending_portal_identities(account_id, last_seen_at)`
    );

    // ── Sync events learn which identity a run was about ──
    const evCols = columnNames(db, "integration_sync_events");
    if (evCols.length > 0) {
      // FK'd with ON DELETE SET NULL, like the document provenance link in 130: an event
      // history outlives the registry entry it named, but it must never name a row that
      // is gone. deletePortal nulls both explicitly too, for the foreign_keys-off case.
      if (!evCols.includes("portal_id")) {
        db.exec(
          `ALTER TABLE integration_sync_events ADD COLUMN portal_id INTEGER
             REFERENCES portals(id) ON DELETE SET NULL`
        );
      }
      if (!evCols.includes("account_id")) {
        db.exec(
          `ALTER TABLE integration_sync_events ADD COLUMN account_id INTEGER
             REFERENCES portal_accounts(id) ON DELETE SET NULL`
        );
      }
      if (!evCols.includes("patient_label")) {
        db.exec(
          "ALTER TABLE integration_sync_events ADD COLUMN patient_label TEXT"
        );
      }
      // The card asks "when was THIS triple last synced", newest first, per profile.
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_sync_events_identity
           ON integration_sync_events(portal_id, account_id, patient_label, at)`
      );
    }

    // ── The one-shot provider rename: 'mychart' → 'patient-portals' ──
    //
    // The integration was named for the first TOOL that implements the contract; it is
    // really the CCD/C-CDA patient-portal family (ONC View/Download/Transmit makes that
    // export a regulatory requirement, so Cerner/Oracle Health, athenahealth and NextGen
    // emit the same document family). The registry id is the string these two tables
    // store, so renaming the integration without moving the stored rows would orphan
    // every prior run's history and every connection row — "Last synced: never" beside a
    // full event log.
    //
    // A one-shot data move belongs in a migration, not a settings flag or a read-time
    // fallback (CLAUDE.md), and it goes HERE rather than in its own slot because it is
    // part of the same re-spec.
    //
    // ORDERING: this runs AFTER the ADD COLUMNs above, though the two are independent —
    // the new columns are NULL on every pre-existing row, and `provider` is an untouched
    // pre-existing column. There is also no uniqueness hazard: integration_connections is
    // PRIMARY KEY (profile_id, provider), so an UPDATE could in principle collide with an
    // existing 'patient-portals' row — but that string has never been a registry id in any
    // shipped version, so no such row can exist. The statement is written to be
    // idempotent-safe on replay regardless (it matches only the old value).
    db.exec(
      `UPDATE integration_sync_events SET provider = 'patient-portals'
        WHERE provider = 'mychart'`
    );
    db.exec(
      `UPDATE integration_connections SET provider = 'patient-portals'
        WHERE provider = 'mychart'`
    );
  });
  run.immediate();
}

export const migration: Migration = {
  id: 131,
  name: "131-portal-accounts",
  up,
};
