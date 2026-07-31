import { db, writeTx } from "./db";
import { sqlNow } from "./clock";
import { shiftDateStr } from "./date";
import {
  POST_VISIT_WINDOW_DAYS,
  isStalenessDue,
  isSyncRequestOpen,
  shouldWriteSyncRequest,
  syncRequestExpiresAt,
  type SyncRequestFacts,
  type SyncRequestReason,
} from "./sync-requests";

// Portal SYNC REQUESTS — the DB half (issue #1757). The pure decisions live in
// lib/sync-requests.ts; this module stores rows, evaluates the three creators, and
// resolves who a request should reach.
//
// AUTH-BLIND by house rule. Nothing here imports lib/auth: a Server Action authorizes,
// then calls in. The reads that touch login/grant tables are the NOTIFICATION EDGE SET
// (login_profiles + logins.own_profile_id), exactly as lib/notifications/fan-out.ts reads
// them — those are login/grant tables, not profile-owned data, so the profile filter
// lives in the query rather than in a `profile_id = ?` scope. Resolving an audience is
// data, never a gate.
//
// ── WHAT A REQUEST IS ────────────────────────────────────────────────────────
//
// One row per portal LOGIN (migration 133 keys on `account_id`), holding the open ask if
// there is one. Openness is DERIVED at read time — not expired, and no run report for
// that login at-or-after the request — so the tool never learns requests exist and there
// is no second write path on the report endpoint to keep consistent.

export interface SyncRequest extends SyncRequestFacts {
  portalId: number;
  portalSlug: string;
  portalName: string;
  accountId: number;
  accountSlug: string;
  accountName: string;
  accountImplicit: boolean;
  // The account's most recent run report, whatever its outcome — the answering signal.
  lastReportAt: string | null;
  // The most recent SUCCESSFUL run for this login. The staleness clock reads this one:
  // a failed run is not a check, and letting it advance the clock would silence the
  // nudge precisely when the portal stopped working. Answering deliberately reads the
  // other one (a failed run still means the person went to the machine).
  lastOkAt: string | null;
}

const REQUEST_COLS = `r.account_id AS accountId, r.portal_id AS portalId,
  p.slug AS portalSlug, p.name AS portalName,
  a.slug AS accountSlug, a.name AS accountName, a.implicit AS accountImplicit,
  r.reason AS reason, r.created_at AS createdAt, r.expires_at AS expiresAt,
  rr.at AS lastReportAt,
  CASE WHEN rr.ok = 1 THEN rr.at ELSE NULL END AS lastOkAt`;

const REQUEST_FROM = `FROM portal_sync_requests r
  JOIN portals p ON p.id = r.portal_id
  JOIN portal_accounts a ON a.id = r.account_id
  LEFT JOIN portal_run_reports rr ON rr.account_id = r.account_id`;

const LIST_REQUESTS_STMT = db.prepare(
  `SELECT ${REQUEST_COLS} ${REQUEST_FROM} ORDER BY p.name COLLATE NOCASE, a.name COLLATE NOCASE`
);

const REQUEST_FOR_ACCOUNT_STMT = db.prepare(
  `SELECT ${REQUEST_COLS} ${REQUEST_FROM} WHERE r.account_id = ?`
);

function toRequest(row: Record<string, unknown>): SyncRequest {
  return {
    accountId: row.accountId as number,
    portalId: row.portalId as number,
    portalSlug: row.portalSlug as string,
    portalName: row.portalName as string,
    accountSlug: row.accountSlug as string,
    accountName: row.accountName as string,
    accountImplicit: (row.accountImplicit as number) === 1,
    reason: row.reason as SyncRequestReason,
    createdAt: row.createdAt as string,
    expiresAt: row.expiresAt as string,
    lastReportAt: (row.lastReportAt as string | null) ?? null,
    lastOkAt: (row.lastOkAt as string | null) ?? null,
  };
}

// The stored request for one portal login, open or not. Null when there has never been
// one (or the last one was replaced away — there is only ever the current row).
export function syncRequestForAccount(accountId: number): SyncRequest | null {
  const row = REQUEST_FOR_ACCOUNT_STMT.get(accountId) as
    Record<string, unknown> | undefined;
  return row ? toRequest(row) : null;
}

// Every request row, whatever its state. Callers that want only live asks filter with
// `isSyncRequestOpen` — the ONE definition — rather than re-deriving openness in SQL,
// so the page, the card, the digest and the tests can never disagree about it.
export function listSyncRequests(): SyncRequest[] {
  return (LIST_REQUESTS_STMT.all() as Record<string, unknown>[]).map(toRequest);
}

// The open ones, at `now` (a SQL-shaped stamp; defaults to the clock seam).
export function openSyncRequests(now: string = sqlNow()): SyncRequest[] {
  return listSyncRequests().filter((r) =>
    isSyncRequestOpen(r, r.lastReportAt, now)
  );
}

// ── Creation ─────────────────────────────────────────────────────────────────

export type SyncRequestOutcome =
  | { ok: true; created: true; request: SyncRequest }
  // Not an error: a request for this login is already open and at least as salient, so
  // asking again would ask one person to do one thing twice. Callers render this as
  // "already requested", never as a failure.
  | { ok: true; created: false; request: SyncRequest }
  | { ok: false; error: "unknown-account" }
  // No patient on this login is bound to a profile, so a nudge would have no Upcoming to
  // live on and no household member to reach. First contact is the card's own job.
  | { ok: false; error: "no-mapped-patients" };

const ACCOUNT_ROW_STMT = db.prepare(
  "SELECT id, portal_id AS portalId FROM portal_accounts WHERE id = ?"
);

const MAPPED_COUNT_STMT = db.prepare(
  `SELECT COUNT(*) AS n FROM portal_identities
    WHERE account_id = ? AND ignored = 0 AND profile_id IS NOT NULL`
);

// How many patients on this portal login are bound to a profile. Zero silences every
// creator — see isStalenessDue's header for why that is checked first.
export function mappedPatientCount(accountId: number): number {
  return (MAPPED_COUNT_STMT.get(accountId) as { n: number }).n;
}

const ALL_ACCOUNT_IDS_STMT = db.prepare(
  "SELECT id AS accountId FROM portal_accounts ORDER BY id"
);

const MAPPED_PROFILES_STMT = db.prepare(
  `SELECT DISTINCT profile_id AS profileId FROM portal_identities
    WHERE account_id = ? AND ignored = 0 AND profile_id IS NOT NULL
    ORDER BY profile_id`
);

// The profiles bound under this portal login. The request is ABOUT this login; these are
// the people whose records it would bring in, and therefore whose Upcoming carries it.
export function mappedProfilesForAccount(accountId: number): number[] {
  return (MAPPED_PROFILES_STMT.all(accountId) as { profileId: number }[]).map(
    (r) => r.profileId
  );
}

// Raise a request for one portal login. The supersession decision is pure
// (shouldWriteSyncRequest) and is evaluated INSIDE the write transaction alongside the
// upsert, so two creators firing at once cannot both decide they may replace the same
// open row.
export function requestSync(
  accountId: number,
  reason: SyncRequestReason,
  now: string = sqlNow()
): SyncRequestOutcome {
  const account = ACCOUNT_ROW_STMT.get(accountId) as
    { id: number; portalId: number } | undefined;
  if (!account) return { ok: false, error: "unknown-account" };
  if (mappedPatientCount(accountId) <= 0) {
    return { ok: false, error: "no-mapped-patients" };
  }

  const created = writeTx((): boolean => {
    const existing = syncRequestForAccount(accountId);
    const open = existing
      ? isSyncRequestOpen(existing, existing.lastReportAt, now)
      : false;
    if (!shouldWriteSyncRequest(existing, open, reason)) return false;
    db.prepare(
      `INSERT INTO portal_sync_requests
         (account_id, portal_id, reason, created_at, expires_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(account_id)
       DO UPDATE SET portal_id = excluded.portal_id,
                     reason = excluded.reason,
                     created_at = excluded.created_at,
                     expires_at = excluded.expires_at`
    ).run(accountId, account.portalId, reason, now, syncRequestExpiresAt(now));
    return true;
  });

  // Re-read so the caller renders the row that actually exists, not the one it hoped for.
  const request = syncRequestForAccount(accountId)!;
  return { ok: true, created, request };
}

// ── Creator 1: staleness ─────────────────────────────────────────────────────

const STALENESS_CANDIDATES_STMT = db.prepare(
  `SELECT a.id AS accountId,
          (SELECT COUNT(*) FROM portal_identities i
            WHERE i.account_id = a.id AND i.ignored = 0 AND i.profile_id IS NOT NULL)
            AS mapped,
          (SELECT r.at FROM portal_run_reports r
            WHERE r.account_id = a.id AND r.ok = 1) AS lastOkAt
     FROM portal_accounts a
    ORDER BY a.id`
);

// The profile-local "today" a portal login's dates are judged against: its FIRST mapped
// profile's. The per-profile-context trap (#1096) applies here too — a cadence must not
// be evaluated in another household member's clock — and the request is ABOUT the
// patients bound under this login, so one of them owns the calendar. First by id, so the
// choice is deterministic; at 30-day granularity the members' timezones cannot disagree
// about a boundary in any way a household would notice, but the composition is what keeps
// that true rather than lucky.
export type TodayForProfile = (profileId: number) => string;

function accountToday(
  accountId: number,
  todayFor: TodayForProfile
): string | null {
  const [first] = mappedProfilesForAccount(accountId);
  return first == null ? null : todayFor(first);
}

// Raise a staleness request for every portal login whose last SUCCESSFUL check is past
// the cadence. Global (a portal login is not profile-owned), cheap (a household has a
// handful of logins), and idempotent: a login that already has an open request of equal
// or greater salience is a no-op, so running this hourly forever writes nothing.
export function evaluateStalenessRequests(
  todayFor: TodayForProfile,
  now: string = sqlNow()
): number {
  let raised = 0;
  for (const row of STALENESS_CANDIDATES_STMT.all() as {
    accountId: number;
    mapped: number;
    lastOkAt: string | null;
  }[]) {
    const today = accountToday(row.accountId, todayFor);
    if (today === null) continue; // no mapped patients — silent, by the pure rule below
    if (
      !isStalenessDue({
        mappedPatients: row.mapped,
        lastCheckedAt: row.lastOkAt,
        today,
      })
    ) {
      continue;
    }
    const out = requestSync(row.accountId, "staleness", now);
    if (out.ok && out.created) raised++;
  }
  return raised;
}

// ── Creator 2: post-visit ────────────────────────────────────────────────────

// A visit that just happened, for a profile bound under this portal login.
//
// READ-TIME, NOT A WRITE TRIGGER — the house pattern. The appointment write paths know
// nothing about portals, and hanging a portal side effect off "save appointment" would
// put a second reason to fail inside a form the user is trying to submit. Instead the
// tick asks the question the same way every other evaluator does: what is true now.
//
// APPOINTMENTS, NOT ENCOUNTERS, deliberately. `appointments` is the household's own
// calendar — a plan that has now passed. `encounters` are records that ARRIVED, and the
// overwhelming majority of them arrived from the very portal this would nudge, so keying
// on them would nudge a household to re-fetch what it just fetched. A cancelled
// appointment is excluded: nothing happened, so nothing was published.
const POST_VISIT_ACCOUNTS_STMT = db.prepare(
  `SELECT DISTINCT i.account_id AS accountId
     FROM appointments ap
     JOIN portal_identities i ON i.profile_id = ap.profile_id
    WHERE i.ignored = 0
      AND i.profile_id IS NOT NULL
      AND ap.status <> 'cancelled'
      AND date(ap.scheduled_at) <= ?
      AND date(ap.scheduled_at) >= ?
    ORDER BY i.account_id`
);

// Raise a post-visit request for every portal login covering a profile whose visit fell
// inside the window. MAPPED PROFILES ONLY, structurally: the join IS the mapping, so a
// visit for someone with no binding on any portal can raise nothing.
export function evaluatePostVisitRequests(
  todayFor: TodayForProfile,
  now: string = sqlNow()
): number {
  let raised = 0;
  const seen = new Set<number>();
  // Composed per ACCOUNT so each window is measured in its own mapped profile's clock,
  // then asked of the DB once per account. A household has a handful of logins.
  for (const row of ALL_ACCOUNT_IDS_STMT.all() as { accountId: number }[]) {
    const today = accountToday(row.accountId, todayFor);
    if (today === null) continue;
    const from = shiftDateStr(today, -POST_VISIT_WINDOW_DAYS);
    for (const hit of POST_VISIT_ACCOUNTS_STMT.all(today, from) as {
      accountId: number;
    }[]) {
      if (hit.accountId !== row.accountId || seen.has(hit.accountId)) continue;
      seen.add(hit.accountId);
      const out = requestSync(hit.accountId, "post-visit", now);
      if (out.ok && out.created) raised++;
    }
  }
  return raised;
}

// The whole evaluation pass, for the hourly tick. Returns how many asks it raised.
export function evaluateSyncRequests(
  todayFor: TodayForProfile,
  now: string = sqlNow()
): { staleness: number; postVisit: number } {
  return {
    staleness: evaluateStalenessRequests(todayFor, now),
    postVisit: evaluatePostVisitRequests(todayFor, now),
  };
}

// ── Delivery routing ─────────────────────────────────────────────────────────
//
// WHOSE PHONE. The token that historically reports `(ochsner, mom)` belongs to a login,
// and logins own the delivery channels — so Mom's phone buzzes about Mom's portal. That
// attribution is `portal_run_reports.reported_by_login_id` (migration 133), overwritten
// with each run so a machine handed to a different person re-points itself by running
// once.
//
// THE FALLBACK, when no token has ever reported the pair (or the reporting login has
// since been deleted): the logins with WRITE access to the mapped profiles. Not read
// access — a caregiver who may only look at Grandma's record cannot be the person asked
// to go run a tool that files documents into it.
//
// The edge set is the NOTIFICATION one (explicit grants ∪ the login's own profile), never
// the admin-bypass-all rule — the one deliberate departure from admin-sees-all that
// fan-out.ts documents. An admin who can act as every profile must not be volunteered to
// run every household's portal tool.

export type SyncRequestRouting = "reporter" | "write-access";

export interface SyncRequestReach {
  loginIds: number[];
  routing: SyncRequestRouting;
}

const REPORTER_LOGIN_STMT = db.prepare(
  `SELECT r.reported_by_login_id AS loginId
     FROM portal_run_reports r
     JOIN logins l ON l.id = r.reported_by_login_id
    WHERE r.account_id = ?`
);

const WRITE_ACCESS_LOGINS_STMT = db.prepare(
  `SELECT DISTINCT lp.login_id AS loginId
     FROM login_profiles lp
     JOIN portal_identities i ON i.profile_id = lp.profile_id
    WHERE i.account_id = ? AND i.ignored = 0 AND lp.access <> 'read'
    UNION
   SELECT DISTINCT l.id AS loginId
     FROM logins l
     JOIN portal_identities i ON i.profile_id = l.own_profile_id
    WHERE i.account_id = ? AND i.ignored = 0
    ORDER BY loginId`
);

// The logins a request for this portal login should reach.
export function syncRequestRecipients(accountId: number): SyncRequestReach {
  const reporter = REPORTER_LOGIN_STMT.get(accountId) as
    { loginId: number } | undefined;
  if (reporter?.loginId != null) {
    return { loginIds: [reporter.loginId], routing: "reporter" };
  }
  const rows = WRITE_ACCESS_LOGINS_STMT.all(accountId, accountId) as {
    loginId: number;
  }[];
  return { loginIds: rows.map((r) => r.loginId), routing: "write-access" };
}

const MANAGED_PROFILES_STMT = db.prepare(
  `SELECT profile_id AS profileId FROM login_profiles WHERE login_id = ?
   UNION
   SELECT own_profile_id AS profileId FROM logins
     WHERE id = ? AND own_profile_id IS NOT NULL`
);

// WHICH mapped profiles actually CARRY the nudge — the routing made visible.
//
// The reach machinery this rides is profile-shaped: an Upcoming item lives on a profile,
// and the morning digest is one message per profile fanned out to that profile's managing
// logins. So "route to the reporting login" is expressed by choosing WHICH of the mapped
// profiles the item appears on: the ones the recipient logins manage. That reaches the
// person who runs the tool through machinery that already exists, and adds no dedicated
// send — the constraint that matters most here, because portal hygiene is never a safety
// signal.
//
// When no recipient manages any mapped profile (a household mid-reshuffle), EVERY mapped
// profile carries it. A nudge nobody would see is worse than one seen by one person too
// many, and the request expires on its own either way.
export function syncRequestCarrierProfiles(accountId: number): number[] {
  const mapped = mappedProfilesForAccount(accountId);
  if (mapped.length === 0) return [];
  const reach = syncRequestRecipients(accountId);
  const managed = new Set<number>();
  for (const loginId of reach.loginIds) {
    for (const row of MANAGED_PROFILES_STMT.all(loginId, loginId) as {
      profileId: number;
    }[]) {
      managed.add(row.profileId);
    }
  }
  const carriers = mapped.filter((id) => managed.has(id));
  return carriers.length > 0 ? carriers : mapped;
}
