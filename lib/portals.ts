import { db, writeTx } from "./db";
import { sqlNow } from "./clock";
import {
  isAccountSlug,
  isPatientLabel,
  mintSlug,
  normalizePatientLabel,
  rejectsAddress,
  reportAdvancesStalenessClock,
  reportAnswersRequest,
  reportIsUnattendedFailure,
  PORTAL_NAME_MAX,
  type IdentityOutcome,
  type ReportedIdentity,
  type SyncReportStatus,
} from "./acquirer-identity";

// The portal registry, the ACCOUNT registry, and the
// `(portal, account, patient-label) → profile` identity mapping (issue #1739) — the DB
// half of the acquirer surface. The pure vocabulary lives in lib/acquirer-identity.ts and
// nothing here re-implements it.
//
// ── THE ONE RULE ─────────────────────────────────────────────────────────────
//
// A mapping is NEVER a bypass of profile authorization. `resolvePortalIdentity` answers
// "which profile did the user bind this patient label to", and stops. Whether the CALLER
// may write to that profile is a separate question the route answers by intersecting the
// resolved id with the token's `accessForProfile` write set — the same seam
// authenticateApiToken/route authorization already use. A binding that resolves to a
// profile the pushing token cannot write is refused exactly as loudly as an unknown one.
//
// ── AND THE ONE REFUSAL ──────────────────────────────────────────────────────
//
// An unmapped identity REFUSES; it never defaults. When a new proxy patient appears on a
// portal — a child turning into an adult account, a parent added to someone's proxy list
// — the correct behaviour is a visible failure that becomes a one-tap binding, not a
// silent landing on whichever profile seemed closest. There is deliberately no fallback
// to an "active" or "first" profile anywhere in this module.
//
// The refusal is also NON-ORACULAR. Unknown, ignored, and ambiguous-account all answer
// the same `unmapped-identity`, so a token holder cannot use the endpoint to learn which
// patients a household has declined or how many logins a portal has.
//
// ── WHY THREE PARTS ──────────────────────────────────────────────────────────
//
// A patient label is unique per LOGIN, not per portal: two parents' proxy lists can both
// render "SMITH, ALEX" meaning two different people. The key therefore carries the
// account. See migration 131 for the full argument and the CHECK that keeps an ignored
// binding from carrying a profile.

// The software vocabulary, ONE source (#1836). The union type, the write-boundary guard
// and the form's option values all derive from this tuple, so the enum and the guard
// cannot drift — the form options remain the one place holding display labels. The
// column is bare TEXT validated here at the write boundary (like
// `integration_connections.status`), so growing this list needs no migration.
export const SOFTWARE_VALUES = [
  "mychart",
  "cerner",
  "ecw",
  "generic-ccd",
] as const;

export type PortalSoftware = (typeof SOFTWARE_VALUES)[number];

export interface Portal {
  id: number;
  slug: string;
  name: string;
  software: PortalSoftware | null;
  createdAt: string;
}

export interface PortalAccount {
  id: number;
  portalId: number;
  slug: string;
  name: string;
  implicit: boolean;
  createdAt: string;
}

export interface PortalIdentity {
  id: number;
  portalId: number;
  portalSlug: string;
  portalName: string;
  accountId: number;
  accountSlug: string;
  accountName: string;
  accountImplicit: boolean;
  patientLabel: string;
  // NULL for an IGNORED binding — the CHECK in migration 131 makes those two states
  // inseparable, so a caller never has to consider "ignored but pointing somewhere".
  profileId: number | null;
  ignored: boolean;
  // THE PORTAL REFUSES THE DOWNLOAD for this person (#1889). Standing state, not an
  // event, and deliberately NOT coupled to `ignored`: an ignored label names nobody
  // here, while a declined one is bound to a real profile whose records the household
  // does want and the portal will not hand over. Set by a run reporting the outcome,
  // cleared by the first successful collection.
  declined: boolean;
  updatedAt: string;
}

// ── Portal registry ──────────────────────────────────────────────────────────

const PORTAL_COLS = `id, slug, name, software, created_at AS createdAt`;

const LIST_PORTALS_STMT = db.prepare(
  `SELECT ${PORTAL_COLS} FROM portals ORDER BY name COLLATE NOCASE`
);

export function listPortals(): Portal[] {
  return LIST_PORTALS_STMT.all() as Portal[];
}

const PORTAL_BY_SLUG_STMT = db.prepare(
  `SELECT ${PORTAL_COLS} FROM portals WHERE slug = ? COLLATE NOCASE`
);

export function portalBySlug(slug: string): Portal | null {
  return (PORTAL_BY_SLUG_STMT.get(slug) as Portal | undefined) ?? null;
}

const PORTAL_BY_ID_STMT = db.prepare(
  `SELECT ${PORTAL_COLS} FROM portals WHERE id = ?`
);

// One portal by its id — how the document detail page turns a stored
// `acquired_portal_id` into "Acquired via Ochsner MyChart" (#1748). The registry is
// GLOBAL (a household sees one "Ochsner MyChart"), so there is nothing to scope here.
export function portalById(id: number): Portal | null {
  return (PORTAL_BY_ID_STMT.get(id) as Portal | undefined) ?? null;
}

export type PortalWriteResult =
  { ok: true; id: number } | { ok: false; error: string };

export function isPortalSoftware(value: string): value is PortalSoftware {
  return (SOFTWARE_VALUES as readonly string[]).includes(value);
}

// Mint a slug that is free within `taken`, appending a counter when a name collides.
// Shared by portals (unique instance-wide) and accounts (unique within their portal), so
// there is exactly one answer to "what does this name become".
function uniqueSlug(base: string, taken: (slug: string) => boolean): string {
  if (!taken(base)) return base;
  for (let n = 2; n < 1000; n++) {
    const candidate = `${base}-${n}`;
    if (!taken(candidate)) return candidate;
  }
  return "";
}

// Register a portal from its DISPLAY NAME; allos mints the slug.
//
// The user names the thing and allos derives the key, because the slug is what a tool's
// local config quotes on every machine: a user-typed slug invites a later "tidy-up" that
// silently breaks every device, while a minted one is stable and a RENAME touches only
// the display name.
//
// Validation is the security boundary, not a convenience: the display NAME is refused if
// it looks like an address. The schema has no URL column at all (migration 128), so this
// closes the only remaining way an address could enter the authoritative record — a human
// pasting one into the free-text field.
//
// Creates the portal's IMPLICIT ACCOUNT in the same transaction. Every binding names an
// account from birth, so a single-login household never meets the concept while the
// storage is never ambiguous.
export function createPortal(
  name: string,
  software?: string | null
): PortalWriteResult {
  const n = name.trim().slice(0, PORTAL_NAME_MAX);
  if (!n) return { ok: false, error: "Give the portal a name." };
  if (rejectsAddress(n)) {
    return {
      ok: false,
      error:
        "A portal is recorded by name only — never a web address. The companion tool holds the address on your own machine.",
    };
  }
  const soft = (software ?? "").trim();
  if (soft !== "" && !isPortalSoftware(soft)) {
    return { ok: false, error: "Unknown portal software." };
  }
  const base = mintSlug(n);
  if (!base) {
    return {
      ok: false,
      error: "Give the portal a name with some letters or digits in it.",
    };
  }

  return writeTx((): PortalWriteResult => {
    const slug = uniqueSlug(base, (s) => portalBySlug(s) !== null);
    if (!slug) {
      return { ok: false, error: "Too many portals with that name already." };
    }
    const info = db
      .prepare(
        "INSERT INTO portals (slug, name, software, created_at) VALUES (?, ?, ?, datetime('now'))"
      )
      .run(slug, n, soft === "" ? null : soft);
    const portalId = Number(info.lastInsertRowid);
    db.prepare(
      `INSERT INTO portal_accounts (portal_id, slug, name, implicit, created_at)
       VALUES (?, 'default', 'Default login', 1, datetime('now'))`
    ).run(portalId);
    return { ok: true, id: portalId };
  });
}

// Rename a portal WITHOUT touching its slug — the whole point of minting the slug once.
// Every tool config that quotes the old slug keeps working.
export function renamePortal(
  portalId: number,
  name: string
): PortalWriteResult {
  const n = name.trim().slice(0, PORTAL_NAME_MAX);
  if (!n) return { ok: false, error: "Give the portal a name." };
  if (rejectsAddress(n)) {
    return {
      ok: false,
      error:
        "A portal is recorded by name only — never a web address. The companion tool holds the address on your own machine.",
    };
  }
  const changed = db
    .prepare("UPDATE portals SET name = ? WHERE id = ?")
    .run(n, portalId).changes;
  return changed > 0
    ? { ok: true, id: portalId }
    : { ok: false, error: "That portal is already gone." };
}

// Change a portal's software tag after creation (#1836 — previously create-time only).
// Display metadata and a sanity-check hint for the companion tool, never identity: the
// slug and every binding are untouched, so nothing a tool config quotes can move here.
export function setPortalSoftware(
  portalId: number,
  software: string | null
): PortalWriteResult {
  const soft = (software ?? "").trim();
  if (soft !== "" && !isPortalSoftware(soft)) {
    return { ok: false, error: "Unknown portal software." };
  }
  const changed = db
    .prepare("UPDATE portals SET software = ? WHERE id = ?")
    .run(soft === "" ? null : soft, portalId).changes;
  return changed > 0
    ? { ok: true, id: portalId }
    : { ok: false, error: "That portal is already gone." };
}

// Remove a portal. Its accounts, bindings, pending identities, the acquisition links on
// documents and the identity stamps on sync events all cascade (FK ON DELETE CASCADE /
// SET NULL), and each is also cleared explicitly so the teardown holds with foreign_keys
// off — the posture every other multi-table delete in this repo uses.
//
// Nulling `medical_documents.acquired_portal_id` is a deliberate loss, not an oversight:
// provenance points AT the registry entry, so removing the portal from the vocabulary
// removes the ability to name it. The DOCUMENTS are untouched — only the label of how
// they arrived goes, and it goes because the thing it named no longer exists. Same for
// the sync events' identity stamps.
export function deletePortal(portalId: number): boolean {
  return writeTx((): boolean => {
    db.prepare("DELETE FROM portal_identities WHERE portal_id = ?").run(
      portalId
    );
    db.prepare("DELETE FROM pending_portal_identities WHERE portal_id = ?").run(
      portalId
    );
    db.prepare("DELETE FROM portal_run_reports WHERE portal_id = ?").run(
      portalId
    );
    // Open sync requests go with the portal they name (#1757). CASCADE would do it, but
    // the runner disables foreign keys during migrations and this module deletes the
    // other portal children explicitly for exactly that reason.
    db.prepare("DELETE FROM portal_sync_requests WHERE portal_id = ?").run(
      portalId
    );
    db.prepare("DELETE FROM portal_accounts WHERE portal_id = ?").run(portalId);
    db.prepare(
      "UPDATE medical_documents SET acquired_portal_id = NULL WHERE acquired_portal_id = ?"
    ).run(portalId);
    db.prepare(
      "UPDATE integration_sync_events SET portal_id = NULL, account_id = NULL WHERE portal_id = ?"
    ).run(portalId);
    return (
      db.prepare("DELETE FROM portals WHERE id = ?").run(portalId).changes > 0
    );
  });
}

// ── Account registry ─────────────────────────────────────────────────────────

const ACCOUNT_COLS = `id, portal_id AS portalId, slug, name, implicit, created_at AS createdAt`;

const LIST_ACCOUNTS_STMT = db.prepare(
  `SELECT ${ACCOUNT_COLS} FROM portal_accounts
    ORDER BY portal_id, name COLLATE NOCASE`
);

function toAccount(row: Record<string, unknown>): PortalAccount {
  return {
    id: row.id as number,
    portalId: row.portalId as number,
    slug: row.slug as string,
    name: row.name as string,
    implicit: (row.implicit as number) === 1,
    createdAt: row.createdAt as string,
  };
}

export function listPortalAccounts(): PortalAccount[] {
  return (LIST_ACCOUNTS_STMT.all() as Record<string, unknown>[]).map(toAccount);
}

const ACCOUNTS_FOR_PORTAL_STMT = db.prepare(
  `SELECT ${ACCOUNT_COLS} FROM portal_accounts WHERE portal_id = ?
    ORDER BY name COLLATE NOCASE`
);

export function accountsForPortal(portalId: number): PortalAccount[] {
  return (
    ACCOUNTS_FOR_PORTAL_STMT.all(portalId) as Record<string, unknown>[]
  ).map(toAccount);
}

// HOW AN ACCOUNT (portal login) NAME IS VALIDATED — one rule, one sentence, for every
// path that names a login (#1829).
//
// The no-address invariant holds in full; the ONE narrowing is that an EMAIL SHAPE is
// allowed, because a portal login usually IS an email and that is the nickname a person
// reaches for. `mailto:`, `https://user@host`, `user@host/path`, a bare `gmail.com` and an
// IP literal are all still refused — rejectsAddress runs those checks BEFORE the
// allowance. A portal NAME keeps full strictness (an institution is not an email, and it
// is the field that tempts URL-pasting).
//
// Exported so any later affordance that renames a login validates identically rather than
// growing a second, drifting copy of the rule.
export const ACCOUNT_NAME_RULE = { allowEmail: true } as const;
export const ACCOUNT_NAME_ERROR =
  "A login is recorded by a name or an email address — never a web address. The companion tool holds the address, and the credentials, on your own machine.";

// Add a named login to a portal ("Mom", "Dad", "mom@example.com"). An account is a LABEL,
// never a credential: no password, nothing that could sign in to anything. Those live only
// in the tool's local config, keyed by the slug this mints.
export function createPortalAccount(
  portalId: number,
  name: string
): PortalWriteResult {
  const n = name.trim().slice(0, PORTAL_NAME_MAX);
  if (!n) return { ok: false, error: "Give the login a name." };
  if (rejectsAddress(n, ACCOUNT_NAME_RULE)) {
    return { ok: false, error: ACCOUNT_NAME_ERROR };
  }
  const base = mintSlug(n);
  if (!base) {
    return {
      ok: false,
      error: "Give the login a name with some letters or digits in it.",
    };
  }
  if (!portalById(portalId)) return { ok: false, error: "Unknown portal." };

  return writeTx((): PortalWriteResult => {
    const existing = new Set(
      accountsForPortal(portalId).map((a) => a.slug.toLowerCase())
    );
    const slug = uniqueSlug(base, (s) => existing.has(s.toLowerCase()));
    if (!slug || !isAccountSlug(slug)) {
      return { ok: false, error: "Too many logins with that name already." };
    }
    const info = db
      .prepare(
        `INSERT INTO portal_accounts (portal_id, slug, name, implicit, created_at)
         VALUES (?, ?, ?, 0, datetime('now'))`
      )
      .run(portalId, slug, n);
    return { ok: true, id: Number(info.lastInsertRowid) };
  });
}

// Rename a login WITHOUT touching its slug (#1836) — the same rename-is-safe property
// the portal registry has: every tool config quotes the slug, which never moves.
// Validates by the ONE login-name rule (#1829): an email SHAPE is valid — a portal login
// usually IS an email, and that is the nickname a person reaches for — while every other
// address shape is still refused before the allowance.
export function renamePortalAccount(
  accountId: number,
  name: string
): PortalWriteResult {
  const n = name.trim().slice(0, PORTAL_NAME_MAX);
  if (!n) return { ok: false, error: "Give the login a name." };
  if (rejectsAddress(n, ACCOUNT_NAME_RULE)) {
    return { ok: false, error: ACCOUNT_NAME_ERROR };
  }
  const changed = db
    .prepare("UPDATE portal_accounts SET name = ? WHERE id = ?")
    .run(n, accountId).changes;
  return changed > 0
    ? { ok: true, id: accountId }
    : { ok: false, error: "That login is already gone." };
}

// Remove a login and everything keyed to it. Refuses to remove a portal's LAST account:
// bindings must always name one, so a portal with no accounts could never be bound
// again — a state with no way out, reached by a single click.
export function deletePortalAccount(accountId: number): boolean {
  return writeTx((): boolean => {
    const row = db
      .prepare("SELECT portal_id AS portalId FROM portal_accounts WHERE id = ?")
      .get(accountId) as { portalId: number } | undefined;
    if (!row) return false;
    const siblings = db
      .prepare("SELECT COUNT(*) AS n FROM portal_accounts WHERE portal_id = ?")
      .get(row.portalId) as { n: number };
    if (siblings.n <= 1) return false;
    db.prepare("DELETE FROM portal_identities WHERE account_id = ?").run(
      accountId
    );
    db.prepare(
      "DELETE FROM pending_portal_identities WHERE account_id = ?"
    ).run(accountId);
    db.prepare("DELETE FROM portal_run_reports WHERE account_id = ?").run(
      accountId
    );
    db.prepare("DELETE FROM portal_sync_requests WHERE account_id = ?").run(
      accountId
    );
    db.prepare(
      "UPDATE integration_sync_events SET account_id = NULL WHERE account_id = ?"
    ).run(accountId);
    return (
      db.prepare("DELETE FROM portal_accounts WHERE id = ?").run(accountId)
        .changes > 0
    );
  });
}

export type AccountResolution =
  | { ok: true; account: PortalAccount }
  // Deliberately ONE reason for every failure: no such portal, no such account slug, and
  // "you omitted it and this portal has more than one login" are indistinguishable to the
  // caller. See the non-oracular note at the top.
  | { ok: false; reason: "unmapped-identity" };

// Resolve `(portal slug, account slug | null)` to exactly one account, or refuse.
//
// THE OMITTED-ACCOUNT RULE, and why it is this one:
//
//   • an omitted account resolves ONLY when the portal has exactly ONE account. Then
//     there is nothing to choose between and no way to be wrong — which is the entire
//     single-login household, and why they never meet the concept.
//   • an omitted account with TWO OR MORE accounts REFUSES. It does not pick the implicit
//     one, the oldest one, or the only one with bindings. Every one of those is a guess
//     about which human's login a run came from, and guessing that is how one person's
//     records land under another's profile — the harm the account component was added to
//     prevent. A household that adds a second login must say which login each device is,
//     and the loud refusal is what tells them to.
//
// The refusal names nothing about the account set, so the endpoint cannot be used to
// count a household's logins.
export function resolveAccount(
  portalSlug: string,
  accountSlug: string | null
): AccountResolution {
  const portal = portalBySlug(portalSlug);
  if (!portal) return { ok: false, reason: "unmapped-identity" };
  const accounts = accountsForPortal(portal.id);
  if (accountSlug === null) {
    if (accounts.length === 1) return { ok: true, account: accounts[0] };
    return { ok: false, reason: "unmapped-identity" };
  }
  const named = accounts.find(
    (a) => a.slug.toLowerCase() === accountSlug.toLowerCase()
  );
  return named
    ? { ok: true, account: named }
    : { ok: false, reason: "unmapped-identity" };
}

// ── Identity bindings ────────────────────────────────────────────────────────

const IDENTITY_COLS = `pi.id AS id, pi.portal_id AS portalId, p.slug AS portalSlug,
          p.name AS portalName, pi.account_id AS accountId, a.slug AS accountSlug,
          a.name AS accountName, a.implicit AS accountImplicit,
          pi.patient_label AS patientLabel, pi.profile_id AS profileId,
          pi.ignored AS ignored, pi.declined AS declined,
          pi.updated_at AS updatedAt`;

const IDENTITY_FROM = `FROM portal_identities pi
     JOIN portals p ON p.id = pi.portal_id
     JOIN portal_accounts a ON a.id = pi.account_id`;

const LIST_IDENTITIES_STMT = db.prepare(
  `SELECT ${IDENTITY_COLS} ${IDENTITY_FROM}
    ORDER BY p.name COLLATE NOCASE, a.name COLLATE NOCASE,
             pi.patient_label COLLATE NOCASE`
);

function toIdentity(row: Record<string, unknown>): PortalIdentity {
  return {
    id: row.id as number,
    portalId: row.portalId as number,
    portalSlug: row.portalSlug as string,
    portalName: row.portalName as string,
    accountId: row.accountId as number,
    accountSlug: row.accountSlug as string,
    accountName: row.accountName as string,
    accountImplicit: (row.accountImplicit as number) === 1,
    patientLabel: row.patientLabel as string,
    profileId: (row.profileId as number | null) ?? null,
    ignored: (row.ignored as number) === 1,
    declined: (row.declined as number) === 1,
    updatedAt: row.updatedAt as string,
  };
}

// Every binding on the instance, for the setup card. Cross-profile by nature — the card
// is an administrative view of "which patient goes where" — so the CALLER filters to what
// its viewer may see; this layer stays scope-blind. Ignored rows are included: they are
// bindings too, and the card must show them or "ignored" becomes invisible state.
export function listPortalIdentities(): PortalIdentity[] {
  return (LIST_IDENTITIES_STMT.all() as Record<string, unknown>[]).map(
    toIdentity
  );
}

export type BindResult =
  { ok: true; id: number } | { ok: false; error: string };

// The write core behind both binding and ignoring. Auth-blind by house rule: the caller
// authorizes `profileId` (or, for an ignore, authorizes nothing because there is nothing
// to authorize — an ignore names no profile).
//
// An ACCESS-CONTROL-ADJACENT write, so it is an atomic upsert rather than
// read-then-write: the UNIQUE(portal_id, account_id, patient_label) index makes the
// binding a KEY, and ON CONFLICT re-points it in one statement. Two admins binding the
// same label concurrently therefore end with one unambiguous answer instead of two rows
// racing to define where a person's records land.
//
// Binding an identity also ANSWERS the question a pending row was asking, so the pending
// row is cleared in the SAME transaction. Two separate writes could leave the household
// staring at a "not mapped yet" prompt for an identity that is now mapped, and one-tap
// mapping straight off that prompt would then bind twice.
function writeBinding(
  accountId: number,
  patientLabel: string,
  profileId: number | null,
  ignored: boolean
): BindResult {
  const label = normalizePatientLabel(patientLabel);
  if (!isPatientLabel(label)) {
    return {
      ok: false,
      error: "Give the patient label exactly as the portal shows it.",
    };
  }
  const account = db
    .prepare(
      "SELECT id, portal_id AS portalId FROM portal_accounts WHERE id = ?"
    )
    .get(accountId) as { id: number; portalId: number } | undefined;
  if (!account) return { ok: false, error: "Unknown portal login." };

  const id = writeTx((): number => {
    const info = db
      .prepare(
        `INSERT INTO portal_identities
           (portal_id, account_id, patient_label, profile_id, ignored, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'), datetime('now'))
         ON CONFLICT(portal_id, account_id, patient_label)
         DO UPDATE SET profile_id = excluded.profile_id,
                       ignored = excluded.ignored,
                       updated_at = datetime('now')`
      )
      .run(account.portalId, account.id, label, profileId, ignored ? 1 : 0);
    db.prepare(
      "DELETE FROM pending_portal_identities WHERE account_id = ? AND patient_label = ?"
    ).run(account.id, label);
    if (info.lastInsertRowid) return Number(info.lastInsertRowid);
    const row = db
      .prepare(
        "SELECT id FROM portal_identities WHERE account_id = ? AND patient_label = ?"
      )
      .get(account.id, label) as { id: number };
    return row.id;
  });
  return { ok: true, id };
}

// Bind a patient label on one LOGIN of a portal to a profile. The caller MUST have
// already authorized `profileId`.
export function bindPortalIdentity(
  accountId: number,
  patientLabel: string,
  profileId: number
): BindResult {
  return writeBinding(accountId, patientLabel, profileId, false);
}

// Mark a patient label as deliberately NOT synced: a real person on the portal whose
// records belong somewhere else. It stops being pending without pretending to be bound —
// the CHECK in migration 131 makes "ignored" and "has a profile" mutually exclusive, so
// an ignore can never quietly point somewhere.
//
// Resolution treats it exactly like an unknown identity, so a tool learns nothing about
// what a household declined.
export function ignorePortalIdentity(
  accountId: number,
  patientLabel: string
): BindResult {
  return writeBinding(accountId, patientLabel, null, true);
}

// Which profile a binding currently points at, or null if there is no such row or the row
// is ignored (an ignored binding has no profile by construction).
//
// This is one of the lookups that RESOLVES a profile rather than filtering by one: the
// caller is asking "who owns this row so I can gate on them", and a `profile_id = ?`
// filter would presuppose the answer. It exists because the surrogate row id arrives from
// a CLIENT (issue #1747).
export function portalIdentityProfile(identityId: number): number | null {
  const row = db
    .prepare(
      "SELECT profile_id AS profileId FROM portal_identities WHERE id = ?"
    )
    .get(identityId) as { profileId: number | null } | undefined;
  return row?.profileId ?? null;
}

// Whether a binding exists at all, and whether it is ignored — so the unbind action can
// tell "already gone" from "ignored, and therefore has no profile to authorize against".
export function portalIdentityState(
  identityId: number
): { profileId: number | null; ignored: boolean } | null {
  const row = db
    .prepare(
      "SELECT profile_id AS profileId, ignored FROM portal_identities WHERE id = ?"
    )
    .get(identityId) as
    { profileId: number | null; ignored: number } | undefined;
  if (!row) return null;
  return { profileId: row.profileId ?? null, ignored: row.ignored === 1 };
}

// Remove a binding, scoped by BOTH its id and the profile it points at.
//
// The profile filter is the COMPARE-AND-SWAP that makes this an atomic access-control
// transition (#1747). The caller resolves the owning profile with portalIdentityProfile()
// and authorizes against it, so between that read and this delete the binding could have
// been RE-POINTED at another profile by a concurrent bind — in which case this statement
// matches nothing and returns false, and the caller reports a typed refusal.
//
// The caller authorizes; this core stays auth-blind (house rule).
export function unbindPortalIdentity(
  identityId: number,
  profileId: number
): boolean {
  return (
    db
      .prepare("DELETE FROM portal_identities WHERE id = ? AND profile_id = ?")
      .run(identityId, profileId).changes > 0
  );
}

// Re-point a bound patient label at a different profile in ONE compare-and-swap (#1836).
//
// This exists so "Change profile" is never unmap-then-rebind: two writes would open a
// window where the label is unmapped and a companion-tool upload arriving mid-edit would
// be refused — the lifecycle-field rule (access-control-adjacent transitions are atomic,
// never read-modify-write).
//
// The `profile_id = expectedProfileId` predicate is the swap's compare: the caller
// resolves the row's current owner, authorizes against BOTH that owner and the new
// target, and this statement re-points the row only if it still means what was
// authorized. A concurrent re-point in between matches nothing, returns false, and the
// caller reports a typed refusal instead of overwriting an answer it never saw.
// `ignored = 0` is belt-and-braces: an ignored row has no profile by CHECK, so the
// expected-profile compare could never match one anyway.
//
// The caller authorizes; this core stays auth-blind (house rule).
export function remapPortalIdentity(
  identityId: number,
  expectedProfileId: number,
  newProfileId: number
): boolean {
  return (
    db
      .prepare(
        `UPDATE portal_identities
            SET profile_id = ?, updated_at = datetime('now')
          WHERE id = ? AND profile_id = ? AND ignored = 0`
      )
      .run(newProfileId, identityId, expectedProfileId).changes > 0
  );
}

// Drop an IGNORED binding — the undo for "ignore", which has no profile and therefore no
// profile-scoped delete to make. Scoped by `ignored = 1` so this can never remove a live
// binding through the un-authorized path an ignore legitimately uses.
export function unignorePortalIdentity(identityId: number): boolean {
  return (
    db
      .prepare("DELETE FROM portal_identities WHERE id = ? AND ignored = 1")
      .run(identityId).changes > 0
  );
}

// ── Per-identity outcomes: the portal DECLINES this person (#1889) ───────────
//
// One run, one sign-in, several patients — and routinely several different answers. The
// report's `identities` list carries a per-identity outcome so one run can tell the truth
// about each patient; this is where those outcomes become STANDING STATE.
//
// WHY STANDING STATE AND NOT AN EVENT. "The portal offers this proxy a preview with no
// Download button" is a settled answer: identical tomorrow, identical next month, and
// nothing the person running the tool can do about it. Reported as a failure it lights
// Data → Review on every run forever, which is how a badge stops being read. Stored as
// state it is said ONCE, quietly, on the card — and it suppresses the nags that would ask
// a person to go and collect what the portal will not give (lib/portal-requests.ts).
//
// SELF-CLEARING, like every other signal here: the first successful collection for that
// patient clears it. Nothing has to remember to tidy up, and a portal that starts
// offering the download again needs no human to notice.
//
// SUGGEST-NEVER-WRITE IS NOT AT STAKE. `declined` is a PORTAL-OBSERVED fact, not a
// user-owned field: the household's own answers live in `ignored` (a person's choice) and
// `profile_id` (a person's binding), and neither is touched here.
//
// Auth-blind by house rule: the route authenticates and resolves the login, then calls in.

export interface IdentityOutcomeTally {
  // Identities newly marked declined by this report.
  declined: number;
  // Identities whose declined state this report CLEARED by collecting.
  cleared: number;
}

const SET_DECLINED_STMT = db.prepare(
  `UPDATE portal_identities
      SET declined = ?, updated_at = datetime('now')
    WHERE account_id = ? AND patient_label = ? AND declined = ?`
);

// Apply the outcomes one run reported for one LOGIN. Entries with no outcome are left
// alone — a client that has never heard of outcomes must not silently clear a standing
// answer by merely listing the label it saw.
export function applyIdentityOutcomes(
  accountId: number,
  entries: readonly ReportedIdentity[]
): IdentityOutcomeTally {
  const stated = entries.filter((e) => e.outcome !== null);
  if (stated.length === 0) return { declined: 0, cleared: 0 };
  return writeTx((): IdentityOutcomeTally => {
    let declined = 0;
    let cleared = 0;
    for (const entry of stated) {
      const want: IdentityOutcome = entry.outcome!;
      const to = want === "declined" ? 1 : 0;
      const changes = SET_DECLINED_STMT.run(
        to,
        accountId,
        entry.label,
        to === 1 ? 0 : 1
      ).changes;
      if (changes > 0) {
        if (to === 1) declined++;
        else cleared++;
      }
    }
    return { declined, cleared };
  });
}

// A successful collection for ONE patient clears their declined state, whether or not the
// run bothered to spell the outcome out. `status: "downloaded"` for a patient IS the
// evidence that the portal offered the download — the same fact `outcome: "collected"`
// carries, arriving by the older spelling.
export function clearIdentityDeclined(
  accountId: number,
  patientLabel: string
): boolean {
  return (
    SET_DECLINED_STMT.run(0, accountId, normalizePatientLabel(patientLabel), 1)
      .changes > 0
  );
}

// ── Resolution (the upload path) ─────────────────────────────────────────────

export interface ResolvedIdentity {
  profileId: number;
  portalId: number;
  accountId: number;
  patientLabel: string;
}

export type IdentityResolution =
  | ({ ok: true } & ResolvedIdentity)
  // The identity is not bound, is ignored, names an unknown portal or login, or omitted
  // its account where that is ambiguous. ONE typed reason for all of them, so the tool
  // surfaces `unmapped-identity` and the card turns it into a pending binding — and a
  // token holder learns nothing about a household's declined patients or login count.
  | { ok: false; reason: "unmapped-identity" };

// Resolve `(portal slug, account slug | null, patient label)` to the profile the user
// bound it to, or refuse.
//
// This is the ONE lookup that RESOLVES which profile to gate on, which is why its SQL
// selects `profile_id` without filtering by it — filtering would presuppose the answer.
// The gate is the protection, not the filter: the caller immediately intersects the
// returned id with the token's `accessForProfile` write set, and an unauthorized result
// is refused. Registered with that justification in the profile-scoping allowlist.
//
// `ignored = 0 AND profile_id IS NOT NULL` is belt-and-braces against the CHECK: the two
// can never disagree, and resolution states its requirement rather than relying on a
// constraint declared in another file.
export function resolvePortalIdentity(
  portalSlug: string,
  accountSlug: string | null,
  patientLabel: string
): IdentityResolution {
  const account = resolveAccount(portalSlug, accountSlug);
  if (!account.ok) return { ok: false, reason: "unmapped-identity" };
  const label = normalizePatientLabel(patientLabel);
  const row = db
    .prepare(
      `SELECT pi.profile_id AS profileId, pi.portal_id AS portalId,
              pi.account_id AS accountId
         FROM portal_identities pi
        WHERE pi.account_id = ? AND pi.patient_label = ?
          AND pi.ignored = 0 AND pi.profile_id IS NOT NULL`
    )
    .get(account.account.id, label) as
    { profileId: number; portalId: number; accountId: number } | undefined;
  if (!row) return { ok: false, reason: "unmapped-identity" };
  return {
    ok: true,
    profileId: row.profileId,
    portalId: row.portalId,
    accountId: row.accountId,
    patientLabel: label,
  };
}

// ── Pending (refused and discovered) identities ──────────────────────────────
//
// A refusal that teaches nobody anything is only half a feature, and discovery is the
// half that makes mapping ROUTINE rather than exceptional. The tool reports the proxy
// patients it actually saw; allos remembers them verbatim; the household binds them off
// the card without ever predicting how a portal renders a name. The refusal path remains
// as the safety net for a patient who appears between runs.
//
// THREE PROPERTIES HOLD THIS TABLE DOWN, and every one of them is load-bearing:
//
//   AUTHENTICATED WRITES ONLY. Every caller records only AFTER authenticateApiToken has
//   succeeded, so a stranger cannot append rows to an instance they have no credential
//   for. There is no anonymous path to this table.
//
//   DEDUPED ON THE NATURAL KEY. UNIQUE(portal_id, account_id, patient_label) + an UPSERT,
//   so a tool reporting the same discovered list every hour bumps ONE row instead of
//   growing 168. The card shows how long this has been waiting and how often it has been
//   seen, which is the useful sentence.
//
//   BOUNDED, TWICE. parseDiscoveredLabels caps ONE report; PENDING_PER_ACCOUNT_CAP caps
//   the stored total per login, evicting least-recently-seen, so even a valid token
//   reporting fresh bogus labels forever leaves a list a human can still read.
//
// A pending row has NO profile_id and cannot have one: not being placeable on a profile
// is what makes it pending. It is therefore not profile-owned and not in OWNED_TABLES.

// How many refused/discovered identities to remember PER LOGIN. Sized for the shape of
// the real thing — one portal login covers a household, so the honest pending list is a
// handful of people and a typo or two; anything past this is a misconfigured tool, not a
// family. Per ACCOUNT rather than per portal so one noisy login cannot evict another's
// pending identities and hide a real new patient.
export const PENDING_PER_ACCOUNT_CAP = 50;

export type PendingOutcome =
  "discovered" | "unmapped-upload" | "unmapped-sync-report";

export interface PendingIdentity {
  id: number;
  portalId: number;
  portalSlug: string;
  portalName: string;
  accountId: number;
  accountSlug: string;
  accountName: string;
  accountImplicit: boolean;
  patientLabel: string;
  firstSeenAt: string;
  lastSeenAt: string;
  seenCount: number;
  lastOutcome: PendingOutcome;
}

// Remember one identity that could not be placed. Returns false when there is nothing to
// remember against.
//
// A label that is ALREADY BOUND OR IGNORED is not pending and is never recorded — that is
// what makes the discovered list idempotent: a tool reporting the same five patients
// every run adds nothing once they are all answered.
//
// The caller MUST have authenticated first. This is not a decorative note: it is the
// property that keeps the table from being an anonymous write amplifier.
// THREE outcomes, not two (#1756). "Recorded" and "newly waiting" are different
// questions and the callers ask different ones: a refusal only needs to know whether it
// remembered anything, while the DISCOVERED count a tool is told — "2 new patients need
// mapping in allos" — is only true if it counts identities that were not already sitting
// on the card. A re-sighting bumps `seen_count` and teaches nobody anything.
type PendingWrite = "new" | "bumped" | "answered";

function writePendingForAccount(
  account: PortalAccount,
  patientLabel: string,
  outcome: PendingOutcome
): PendingWrite {
  const label = normalizePatientLabel(patientLabel);
  if (!isPatientLabel(label)) return "answered";

  // first/last seen come from the CLOCK SEAM (sqlNow, #1534), unlike the registry's own
  // audit stamps: the card reduces both to a calendar DAY ("first seen 2026-01-02"), so
  // they must read the same clock every other day-shaped value in the app reads.
  const now = sqlNow();
  return writeTx((): PendingWrite => {
    const answered = db
      .prepare(
        "SELECT 1 FROM portal_identities WHERE account_id = ? AND patient_label = ?"
      )
      .get(account.id, label);
    if (answered) return "answered";

    // Asked INSIDE the write transaction, so "was this already waiting" and the upsert
    // that answers it cannot be separated by a concurrent report of the same label.
    const already = db
      .prepare(
        "SELECT 1 FROM pending_portal_identities WHERE account_id = ? AND patient_label = ?"
      )
      .get(account.id, label);

    db.prepare(
      `INSERT INTO pending_portal_identities
         (portal_id, account_id, patient_label, first_seen_at, last_seen_at, seen_count, last_outcome)
       VALUES (?, ?, ?, ?, ?, 1, ?)
       ON CONFLICT(portal_id, account_id, patient_label)
       DO UPDATE SET last_seen_at = excluded.last_seen_at,
                     seen_count = seen_count + 1,
                     last_outcome = excluded.last_outcome`
    ).run(account.portalId, account.id, label, now, now, outcome);
    // Evict the least-recently-seen beyond the cap, within THIS login only. Runs in the
    // same transaction as the upsert, so the table can never be observed over its bound.
    db.prepare(
      `DELETE FROM pending_portal_identities
        WHERE account_id = ?
          AND id NOT IN (
            SELECT id FROM pending_portal_identities
             WHERE account_id = ?
             ORDER BY last_seen_at DESC, id DESC
             LIMIT ?
          )`
    ).run(account.id, account.id, PENDING_PER_ACCOUNT_CAP);
    return already ? "bumped" : "new";
  });
}

// Did this identity get remembered at all? The refusal paths' question — an
// already-bound or already-ignored label is not pending and is never recorded.
function recordPendingForAccount(
  account: PortalAccount,
  patientLabel: string,
  outcome: PendingOutcome
): boolean {
  return writePendingForAccount(account, patientLabel, outcome) !== "answered";
}

// Remember an identity that was just REFUSED, named the way the request named it.
//
// An UNKNOWN PORTAL, an unknown login, or an omitted account on a multi-login portal are
// deliberately not remembered: allos owns those vocabularies, so an unresolvable one is a
// misconfigured tool, not a patient waiting to be mapped. Recording them would let any
// authenticated tool invent registry-shaped strings, and the card could offer nothing to
// do about them anyway.
export function recordPendingIdentity(
  portalSlug: string,
  accountSlug: string | null,
  patientLabel: string,
  outcome: PendingOutcome
): boolean {
  const account = resolveAccount(portalSlug, accountSlug);
  if (!account.ok) return false;
  return recordPendingForAccount(account.account, patientLabel, outcome);
}

// Record the proxy-patient list a run DISCOVERED — the routine path by which allos learns
// identities. Already-answered labels are skipped, so a steady-state run that reports the
// same five patients every hour writes nothing at all.
//
// RETURNS HOW MANY ARE NEWLY WAITING — not how many were touched (#1756). This number is
// what the route echoes to the tool, and docs/api-tokens.md promises it means "2 NEW
// patients need mapping in allos". Counting re-sightings would make it a constant that
// says nothing and never falls to zero, so a tool could never tell its user that setup is
// finished.
export function recordDiscoveredIdentities(
  account: PortalAccount,
  labels: string[]
): number {
  let newly = 0;
  for (const label of labels) {
    if (writePendingForAccount(account, label, "discovered") === "new") newly++;
  }
  return newly;
}

const LIST_PENDING_STMT = db.prepare(
  `SELECT pp.id AS id, pp.portal_id AS portalId, p.slug AS portalSlug,
          p.name AS portalName, pp.account_id AS accountId, a.slug AS accountSlug,
          a.name AS accountName, a.implicit AS accountImplicit,
          pp.patient_label AS patientLabel,
          pp.first_seen_at AS firstSeenAt, pp.last_seen_at AS lastSeenAt,
          pp.seen_count AS seenCount, pp.last_outcome AS lastOutcome
     FROM pending_portal_identities pp
     JOIN portals p ON p.id = pp.portal_id
     JOIN portal_accounts a ON a.id = pp.account_id
    ORDER BY pp.last_seen_at DESC, pp.id DESC`
);

// Every identity still waiting for an answer, newest sighting first.
export function listPendingIdentities(): PendingIdentity[] {
  return (LIST_PENDING_STMT.all() as Record<string, unknown>[]).map((row) => ({
    id: row.id as number,
    portalId: row.portalId as number,
    portalSlug: row.portalSlug as string,
    portalName: row.portalName as string,
    accountId: row.accountId as number,
    accountSlug: row.accountSlug as string,
    accountName: row.accountName as string,
    accountImplicit: (row.accountImplicit as number) === 1,
    patientLabel: row.patientLabel as string,
    firstSeenAt: row.firstSeenAt as string,
    lastSeenAt: row.lastSeenAt as string,
    seenCount: row.seenCount as number,
    lastOutcome: row.lastOutcome as PendingOutcome,
  }));
}

// One pending row, for the actions that need its (account, label) before answering it.
export function pendingIdentity(id: number): PendingIdentity | null {
  return listPendingIdentities().find((p) => p.id === id) ?? null;
}

// Drop a pending row without answering it. Unlike IGNORE — which is a durable binding
// saying "never sync this person" — a dismissal only clears the prompt, and the identity
// returns if the tool reports it again. Both exist because they answer different
// questions: "not now" and "not ever".
export function dismissPendingIdentity(id: number): boolean {
  return (
    db.prepare("DELETE FROM pending_portal_identities WHERE id = ?").run(id)
      .changes > 0
  );
}

// ── Account-level run reports (#1756) ────────────────────────────────────────
//
// WHERE A RUN THAT HAS NO PROFILE LEAVES ITS TRACE.
//
// A run that names a BOUND patient belongs to a profile, and its trace is an ordinary
// `integration_sync_events` row — the profile's Review, its failure badge and its "Last
// checked" all read that, and nothing here duplicates it.
//
// Two real runs have no profile at all:
//
//   FIRST CONTACT — the first run enumerates the proxy list and reports it, but its own
//   patient is not bound yet, so the report is refused. Before this table nothing at all
//   recorded that the run happened, and the card said "No run reported yet." directly
//   under its own promise that every run is reported.
//
//   A PORTAL-LEVEL FAILURE — "the login page changed". A fact about the LOGIN, before any
//   patient is reached, which previously had to be smuggled in behind a fabricated
//   patient label.
//
// ONE ROW PER LOGIN, by primary key: this is "the last run this login reported", so an
// authenticated tool reporting every five minutes forever rewrites one row per login it
// can already name. Bounded by construction — no retention sweep to own, and no way to
// grow the table by reporting. See migration 132 for the full argument.
//
// It carries NO profile_id and cannot: not being placeable on a profile is what puts a
// run here. Not profile-owned, not in OWNED_TABLES.

export interface PortalRunReport {
  portalId: number;
  portalSlug: string;
  portalName: string;
  accountId: number;
  accountSlug: string;
  accountName: string;
  accountImplicit: boolean;
  at: string;
  ok: boolean;
  status: SyncReportStatus;
  // The tool's own failure line, or null. Free text from an authenticated but untrusted
  // tool — rendered as text, never as markup.
  message: string | null;
  // NEWLY-WAITING identities this run contributed (what recordDiscoveredIdentities
  // returns), never the length of the reported list. The card and the response the tool
  // gets therefore quote the same number.
  discovered: number;
  // WHAT KIND OF RUN this was (#1888/#1889). Both default to TRUE on the wire, so a row
  // written by a client that has never heard of them reads exactly as it always did.
  contacted: boolean;
  attended: boolean;
}

// Record the run one LOGIN just reported, replacing that login's previous report.
//
// The caller MUST have authenticated first, exactly like recordPendingForAccount: this is
// the other table an authenticated tool can write without naming a profile, and the same
// property — no anonymous path — is what keeps it honest.
export function recordPortalRunReport(
  account: PortalAccount,
  input: {
    ok: boolean;
    status: SyncReportStatus;
    message: string | null;
    discovered: number;
    // WHICH allos login pushed this run (#1757). Null for a path that has no login to
    // name; the sync-report route always has one. This is the ONLY record of who
    // actually runs the tool for a portal login, and it is what lets a sync-request
    // nudge reach that person's own channels instead of broadcasting to the household
    // (lib/portal-requests.ts: syncRequestRecipients). Overwritten with the run, so it
    // always names the login that most recently reported — a machine handed over to a
    // different person re-points it by running once.
    reportedByLoginId?: number | null;
    // WHAT KIND OF RUN (#1888/#1889). Omitted means TRUE — the wire default — so every
    // existing caller keeps its exact meaning.
    contacted?: boolean;
    attended?: boolean;
  }
): void {
  // The clock SEAM (sqlNow, #1534), not datetime('now'): the card reduces this to a
  // calendar day, so it must read the same clock every other day-shaped value reads.
  const now = sqlNow();
  const provenance = {
    contacted: input.contacted !== false,
    attended: input.attended !== false,
    ok: input.ok,
  };
  const message = input.message ? input.message.slice(0, 500) : null;

  // ── THE STICKY CHECK CLOCK (#1888) ──
  //
  // This table holds ONE ROW PER LOGIN — the LAST run it reported — which is what makes
  // it bounded by construction (migration 132). So a delivery-only push OVERWRITES the
  // previous genuine run's stamp, and a read-time `contacted = 1` filter would turn
  // "checked yesterday, pushed today" into "never checked" and raise a staleness nudge
  // one day after a real run: the opposite bug, equally silent.
  //
  // The two clock columns therefore only ever move FORWARD, and only when the ONE pure
  // predicate pair says this report earned it. Every consumer then reads a column
  // instead of restating `contacted !== false` in SQL — the whole point of #1888's
  // first constraint. Passing NULL when the report earns nothing, and COALESCEing on
  // conflict, makes "leave the previous value standing" a property of ONE statement
  // rather than a read-then-write two concurrent reports could interleave.
  const checkedAt = reportAnswersRequest(provenance) ? now : null;
  const checkedOkAt = reportAdvancesStalenessClock(provenance) ? now : null;
  const unattendedFailAt = reportIsUnattendedFailure(provenance) ? now : null;

  db.prepare(
    `INSERT INTO portal_run_reports
       (account_id, portal_id, at, ok, status, message, discovered,
        reported_by_login_id, contacted, attended, checked_at, checked_ok_at,
        unattended_fail_at, unattended_fail_message)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id)
     DO UPDATE SET portal_id = excluded.portal_id,
                   at = excluded.at,
                   ok = excluded.ok,
                   status = excluded.status,
                   message = excluded.message,
                   discovered = excluded.discovered,
                   reported_by_login_id = excluded.reported_by_login_id,
                   contacted = excluded.contacted,
                   attended = excluded.attended,
                   checked_at = COALESCE(excluded.checked_at,
                                         portal_run_reports.checked_at),
                   checked_ok_at = COALESCE(excluded.checked_ok_at,
                                            portal_run_reports.checked_ok_at),
                   -- The escalation clause (#1889) is CLEARED by any report that answers
                   -- the request (the ask it explained is over), SET by a fresh
                   -- unattended failure, and otherwise left standing — a delivery push in
                   -- between must not erase why the machine gave up.
                   unattended_fail_at =
                     CASE WHEN excluded.checked_at IS NOT NULL THEN NULL
                          WHEN excluded.unattended_fail_at IS NOT NULL
                            THEN excluded.unattended_fail_at
                          ELSE portal_run_reports.unattended_fail_at END,
                   unattended_fail_message =
                     CASE WHEN excluded.checked_at IS NOT NULL THEN NULL
                          WHEN excluded.unattended_fail_at IS NOT NULL
                            THEN excluded.unattended_fail_message
                          ELSE portal_run_reports.unattended_fail_message END`
  ).run(
    account.id,
    account.portalId,
    now,
    input.ok ? 1 : 0,
    input.status,
    message,
    Math.max(0, Math.round(input.discovered)),
    input.reportedByLoginId ?? null,
    provenance.contacted ? 1 : 0,
    provenance.attended ? 1 : 0,
    checkedAt,
    checkedOkAt,
    unattendedFailAt,
    unattendedFailAt ? message : null
  );
}

const LIST_RUN_REPORTS_STMT = db.prepare(
  `SELECT r.portal_id AS portalId, p.slug AS portalSlug, p.name AS portalName,
          r.account_id AS accountId, a.slug AS accountSlug, a.name AS accountName,
          a.implicit AS accountImplicit, r.at AS at, r.ok AS ok,
          r.status AS status, r.message AS message, r.discovered AS discovered,
          r.contacted AS contacted, r.attended AS attended
     FROM portal_run_reports r
     JOIN portals p ON p.id = r.portal_id
     JOIN portal_accounts a ON a.id = r.account_id
    ORDER BY r.at DESC, r.account_id DESC`
);

// Every login's last reported run, newest first. Cross-profile by nature — a run report
// is about a portal login, not about a person — and it carries no health data, only the
// registry names the card already shows.
export function listPortalRunReports(): PortalRunReport[] {
  return (LIST_RUN_REPORTS_STMT.all() as Record<string, unknown>[]).map(
    (row) => ({
      portalId: row.portalId as number,
      portalSlug: row.portalSlug as string,
      portalName: row.portalName as string,
      accountId: row.accountId as number,
      accountSlug: row.accountSlug as string,
      accountName: row.accountName as string,
      accountImplicit: (row.accountImplicit as number) === 1,
      at: row.at as string,
      ok: (row.ok as number) === 1,
      status: row.status as SyncReportStatus,
      message: (row.message as string | null) ?? null,
      discovered: row.discovered as number,
      contacted: (row.contacted as number) === 1,
      attended: (row.attended as number) === 1,
    })
  );
}

// ── Per-identity sync status ─────────────────────────────────────────────────

export interface IdentitySyncStatus {
  accountId: number;
  patientLabel: string;
  lastOkAt: string | null;
  lastFailedAt: string | null;
}

// "Last synced" for every (account, patient) this profile has events for — the card's
// per-identity status line. A household with two portals and three patients has six
// answers to "when was this last checked", and the single per-profile connection stamp
// cannot hold them.
//
// Profile-scoped, like every read of this table. Only a SUCCESSFUL run advances
// `lastOkAt` — including a nothing-new one, which is the point: a quiet check is still a
// check. `lastFailedAt` is tracked separately so a failure never erases how long it has
// really been since the portal was last read.
export function identitySyncStatuses(
  profileId: number,
  provider: string
): IdentitySyncStatus[] {
  return db
    .prepare(
      `SELECT account_id AS accountId, patient_label AS patientLabel,
              MAX(CASE WHEN ok = 1 THEN at END) AS lastOkAt,
              MAX(CASE WHEN ok = 0 THEN at END) AS lastFailedAt
         FROM integration_sync_events
        WHERE profile_id = ? AND provider = ?
          AND account_id IS NOT NULL AND patient_label IS NOT NULL
        GROUP BY account_id, patient_label`
    )
    .all(profileId, provider) as IdentitySyncStatus[];
}
