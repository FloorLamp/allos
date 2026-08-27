import { db } from "@/lib/db";
import { profileIdsIn, type AuthorizedProfileIds } from "@/lib/cross-profile";
import type {
  PendingIdentity,
  PendingOutcome,
  Portal,
  PortalAccount,
  PortalRunReport,
  PortalSoftware,
} from "@/lib/portals";
import type { SyncReportStatus } from "@/lib/acquirer-identity";
import { dateFromCreatedAt } from "@/lib/timeline-format";

// WHO MAY SEE A PORTAL ACCOUNT'S RUN REPORT (#1787) — AND ITS REGISTRY ROW (#1796).
//
// `listPortalRunReports()` is instance-wide by construction, and it has to be:
// `portal_run_reports` carries no `profile_id` and cannot, because not being placeable
// on a profile is exactly what puts a run there (#1756). That made it the one input on
// the Patient portals page with neither a scoping filter nor a documented reason for
// having none — while its two neighbours on the same page both have one (`identities` is
// filtered to `accessibleIds`; `pending` is gated behind `canManagePending` with a
// comment calling the wider visibility a deliberate, owner-approved trade).
//
// The consequence was a cross-household DISCLOSURE, not a cosmetic one. The status line
// picks the globally-newest failed report and renders the portal name, the account
// nickname, and the tool's free-text `message` — up to 500 characters supplied by an
// external companion tool through the token-authenticated upload API — to EVERY login
// that can open the page, including one with access to no profile tied to that account.
//
// So the fix belongs here, in the read, not in the card: a surface that filters what it
// was handed is one refactor away from leaking again, and the card is not where the
// authority lives.
//
// THE RULE IS ABOUT THE ACCOUNT, not about the row that hangs off it. A row (a run
// report, a registry entry) is visible to a login when its ACCOUNT is:
//
//   (a) CLAIMED BY SOMEONE THEY CAN REACH — the account has at least one
//       `portal_identities` binding onto a profile in the login's accessible set. This
//       is the same authority `identities` already filters by, so the card cannot name
//       an account whose bindings the same card would hide.
//
//   (b) UNCLAIMED, and the login can act on unclaimed things. An account with NO binding
//       onto ANY profile belongs to no household yet — it is the first-contact case
//       #1756 exists to make visible, and hiding its failure would restore the very dead
//       zone that issue removed. It is shown to exactly the population that already sees
//       the portal-spelled patient labels of `pending`: admins and members with write
//       access to at least one profile. That population is the existing owner-approved
//       trade, reused deliberately rather than widened.
//
// An account claimed ONLY by profiles this login cannot reach is neither, and is
// therefore invisible — the case the bug was about.
//
// WHAT A HIDDEN FAILURE DEGRADES TO: nothing. The reports simply do not reach
// `portalStatusLine`, which then answers from the viewer's OWN state (rule 2/3/4) —
// honest for them, because a portal run they have no tie to is not their status. The
// issue floated a generic "a portal run failed" fallback instead; that would disclose
// the EXISTENCE of another household's failure to someone who can do nothing about it,
// which is a smaller version of the same leak, so it is deliberately not done.

// THE RULE, ONCE, AS SQL. Both readers below embed this same predicate rather than each
// spelling out its own version of "can this login reach that account" — one question,
// one computation (#221). A second engine that agreed today would be a second engine to
// remember tomorrow, and the two surfaces would drift the moment either rule moved.
//
// `accountIdExpr` is the SQL expression naming the account column in the embedding
// query (`r.account_id` for a run report, `a.id` for the registry row itself). It is
// never caller data — the two call sites below pass fixed literals.
//
// BIND ORDER, for every embedding statement: `...ids` first (the profileIdsIn tuple),
// then the 0/1 unclaimed flag. A query embedding this twice binds both twice.
function reachableAccountSql(
  ids: AuthorizedProfileIds,
  accountIdExpr: string
): string {
  return `(
      EXISTS (
        SELECT 1 FROM portal_identities i
         WHERE i.account_id = ${accountIdExpr}
           AND i.profile_id IN ${profileIdsIn(ids)}
      )
      OR (
        ? = 1
        AND NOT EXISTS (
          SELECT 1 FROM portal_identities i2
           WHERE i2.account_id = ${accountIdExpr}
             AND i2.profile_id IS NOT NULL
        )
      )
    )`;
}

// Cross-profile by construction: the caller resolves the accessible set at the auth
// boundary and hands it in as already-authorized ids, and this module never imports
// lib/auth — the cross-profile reader convention. The `profile_id IN (…)` list is built
// with profileIdsIn(), and this module is registered in CROSS_PROFILE_SQL_MODULES.
export function listVisiblePortalRunReports(
  accessibleProfileIds: AuthorizedProfileIds,
  // True when the viewer may also see UNCLAIMED accounts — the `canManagePending`
  // population (admin, or write access to at least one profile). Passed in rather than
  // derived so the page's one gate decides it once for both surfaces.
  canSeeUnclaimed: boolean
): PortalRunReport[] {
  const ids = accessibleProfileIds;
  // An empty accessible set makes clause (a) match nothing. `profileIdsIn([])` renders
  // `(NULL)`, which is the correct empty-set semantics for SQL `IN`, so this still runs
  // as one statement rather than needing a short-circuit — and a login with no
  // accessible profile is exactly the reader the bug exposed the most to.
  const rows = db
    .prepare(
      `SELECT r.portal_id AS portalId, p.slug AS portalSlug, p.name AS portalName,
              r.account_id AS accountId, a.slug AS accountSlug, a.name AS accountName,
              a.implicit AS accountImplicit, r.at AS at, r.ok AS ok,
              r.status AS status, r.message AS message, r.discovered AS discovered,
              r.contacted AS contacted, r.attended AS attended,
              r.checked_at AS checkedAt
         FROM portal_run_reports r
         JOIN portals p ON p.id = r.portal_id
         JOIN portal_accounts a ON a.id = r.account_id
        WHERE ${reachableAccountSql(ids, "r.account_id")}
        ORDER BY r.at DESC, r.account_id DESC`
    )
    .all(...ids, canSeeUnclaimed ? 1 : 0) as Record<string, unknown>[];
  return rows.map((row) => ({
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
    checkedAt: (row.checkedAt as string | null) ?? null,
  }));
}

// ── WHAT A LOGIN DELIVERED, AND WHEN (#2914) ─────────────────────────────────
//
// The login row says "Delivered N documents <day>" for a delivery-only report, and this
// is where both halves come from.
//
// ONE NUMBER, NOT TWO (#1991). N counts DOCUMENTS THE RUNS CLAIMED — the same archives
// the Imports feed's drill-in lists — never the tool's own `inserted + updated` split.
// Those are two independent counts of one delivery and they disagree the moment the
// tool's split differs from what allos stored: three archives reported as
// `inserted 1, unchanged 2` made this page say "1" while the drill-in listed 3. It is
// also the only derivation that survives the observed case #2914 was filed from — a push
// that delivered documents under a report whose status was `nothing-new` and whose split
// was all zeroes.
//
// READ FROM THE DOCUMENTS, NOT FROM THE RUNS, and that is not a stylistic choice. The
// provenance rows expire with their event on the #388 retention sweep, so a count taken
// from them silently falls to zero at 90 days while the archives are still on disk;
// `medical_documents.delivered_at` is a fact about the document and outlives every run.
//
// THE DAY IS THE DELIVERY'S OWN, not the report's — the fix for a push that straddles
// UTC midnight. `portal_run_reports` holds ONE ROW PER LOGIN (migration 132), so joining
// the claims to that row's day meant the day of whichever patient reported LAST: a push
// filing reports at 23:59:52Z and 00:00:05Z excluded everything stamped on the earlier
// day, and the page said "Delivered 2 documents" over five archives the feed listed as
// 3 + 2. Grouping by the day the archives actually landed makes the two surfaces agree
// per day, which is the most any day-grain sentence can honestly claim — there is no run
// boundary to use instead, because the report table keeps no history and the acquirer
// contract carries no run id (both #2914 and #2999 refuse to change it).
//
// So: the login's MOST RECENT delivery day, and how many archives it carried. "Delivered
// 6 documents 2026-08-15" is true of that login on that day whether one push or two
// produced them.
//
// SCOPED LIKE EVERYTHING ELSE ON THIS PAGE. Narrowed to the viewer's own accessible
// profiles AND to accounts the same predicate above admits, so a login row can never be
// given a number drawn from a household this viewer cannot reach.
export interface DeliveredDocuments {
  count: number;
  day: string;
}

// GROUPED IN JS, NOT IN SQL (#3836), and that is the whole point of this shape.
// `delivered_at` is an INSTANT. The per-day tally used to be `GROUP BY
// substr(delivered_at, 1, 10)`, which buckets by the UTC day — so the sentence named a
// day this household never had, and worse, #3835 made the CHECK clock beside it local:
// `checked < on` in portalLoginStatus then compared a UTC day against a local one and
// could flip for the hours a household sits either side of UTC midnight. SQLite has no
// timezone database, so the bucket boundary cannot be computed there; it is computed
// here instead, from the same conversion every other day on this page goes through.
//
// `timeZone` is the VIEWER's, required and not defaulted — the same zone the login row's
// other dates use (#3835: a run report belongs to no profile, so it is the reader's
// calendar). It must stay the same zone as the check clock's, because the two are
// compared: two correct local days in different zones would be the same bug again.
export function deliveredDocumentCountsByAccount(
  accessibleProfileIds: AuthorizedProfileIds,
  canSeeUnclaimed: boolean,
  timeZone: string
): Map<number, DeliveredDocuments> {
  const ids = accessibleProfileIds;
  const rows = db
    .prepare(
      `SELECT pi.account_id AS accountId, d.delivered_at AS deliveredAt
         FROM medical_documents d
         JOIN portal_identities pi ON pi.id = d.acquired_identity_id
        WHERE d.delivered_at IS NOT NULL
          AND d.profile_id IN ${profileIdsIn(ids)}
          AND ${reachableAccountSql(ids, "pi.account_id")}`
    )
    .all(...ids, ...ids, canSeeUnclaimed ? 1 : 0) as {
    accountId: number;
    deliveredAt: string;
  }[];
  // account → (local day → how many archives landed that day).
  const tally = new Map<number, Map<string, number>>();
  for (const r of rows) {
    // A stamp that will not parse keeps the stored prefix rather than dropping the
    // document out of its login's count.
    const day =
      dateFromCreatedAt(r.deliveredAt, timeZone) ?? r.deliveredAt.slice(0, 10);
    const days = tally.get(r.accountId) ?? new Map<string, number>();
    days.set(day, (days.get(day) ?? 0) + 1);
    tally.set(r.accountId, days);
  }
  const out = new Map<number, DeliveredDocuments>();
  for (const [accountId, days] of tally) {
    // The login's MOST RECENT delivery day, as the header says — the max, which the
    // old SQL got from `ORDER BY day` and the last row winning.
    let latest: DeliveredDocuments | null = null;
    for (const [day, count] of days) {
      if (latest === null || day > latest.day) latest = { count, day };
    }
    if (latest) out.set(accountId, latest);
  }
  return out;
}

// ── The pending list a MEMBER may see (#1875) ────────────────────────────────
//
// `listPendingIdentities()` is instance-wide, and the page used to hand the whole thing
// to any member holding write access to ANY profile. A pending row's patient label is a
// portal-reported full name ("WANG, DANA") — exactly the cross-household-member
// disclosure the login/profile access model everywhere else prevents — so a caregiver
// with write access to only the child profile was shown another adult's proxy-patient
// labels from a portal with no connection to anything they can reach.
//
// The rule is the SAME predicate as the run reports and the registry above, applied to
// the pending row's account: a member sees a pending only on a login already claimed by
// a profile they can access (clause a). Clause (b) — unclaimed, first-contact accounts —
// is ADMIN-ONLY territory here (`canSeeUnclaimed` is passed `isAdmin`, not the old
// any-writer population): a first-contact portal has no mappings yet, and "an admin adds
// portals" already owns that era. The fix lives in the read, not in the card, for the
// same reason as #1787's: a surface that filters what it was handed is one refactor away
// from leaking again.
export function listVisiblePendingIdentities(
  accessibleProfileIds: AuthorizedProfileIds,
  // True when the viewer may also see pendings on UNCLAIMED accounts. Per #1875 this is
  // the ADMIN population — first-contact portals are admin-only territory.
  canSeeUnclaimed: boolean
): PendingIdentity[] {
  const ids = accessibleProfileIds;
  const rows = db
    .prepare(
      `SELECT pp.id AS id, pp.portal_id AS portalId, p.slug AS portalSlug,
              p.name AS portalName, pp.account_id AS accountId, a.slug AS accountSlug,
              a.name AS accountName, a.implicit AS accountImplicit,
              pp.patient_label AS patientLabel,
              pp.first_seen_at AS firstSeenAt, pp.last_seen_at AS lastSeenAt,
              pp.seen_count AS seenCount, pp.last_outcome AS lastOutcome
         FROM pending_portal_identities pp
         JOIN portals p ON p.id = pp.portal_id
         JOIN portal_accounts a ON a.id = pp.account_id
        WHERE ${reachableAccountSql(ids, "pp.account_id")}
        ORDER BY pp.last_seen_at DESC, pp.id DESC`
    )
    .all(...ids, canSeeUnclaimed ? 1 : 0) as Record<string, unknown>[];
  return rows.map((row) => ({
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

// ── The write-side gate a RUN REPORT must pass (#2105) ───────────────────────
//
// POST /api/documents/sync-report used to write discovered identities and the
// account-level run report BEFORE its per-profile write gate — so any login able to
// mint an `upload:documents` token could fabricate another login's portal run state,
// stuff pending patient labels onto its mapping list, and stamp `reportedByLoginId`
// onto the row that decides whose channels a sync nudge reaches.
//
// The rule is the SAME predicate as the read side above, applied to the token's WRITE
// set instead of the viewer's accessible set: a token may report on an account when
//
//   (a) it can WRITE at least one profile bound under that account — the population
//       whose records a run on this login actually concerns; or
//   (b) the account is UNCLAIMED and the login can write somewhere — the #1756
//       first-contact case, without which a first run could never report at all (its
//       own patient is not bound yet, which is exactly what the report exists to fix).
//
// A demo-restricted token has an EMPTY write set, so both clauses refuse it. The route
// answers a refusal with its existing non-oracular 404, so an unauthorized probe is
// indistinguishable from an unknown login.
//
// Cross-profile by construction like the readers above: the route resolves the write
// set at its auth boundary and hands in already-authorized ids; this module never
// imports lib/auth.
export function canReportOnAccount(
  writableProfileIds: AuthorizedProfileIds,
  // True when the token may also report on UNCLAIMED accounts — the any-writer
  // population, passed in rather than derived so the route's one boundary decides it.
  canReportUnclaimed: boolean,
  accountId: number
): boolean {
  const ids = writableProfileIds;
  const row = db
    .prepare(
      `SELECT 1 AS ok FROM portal_accounts a
        WHERE a.id = ? AND ${reachableAccountSql(ids, "a.id")}`
    )
    .get(accountId, ...ids, canReportUnclaimed ? 1 : 0);
  return row !== undefined;
}

// ── The registry a tool INGESTS (#1796) ──────────────────────────────────────
//
// `GET /api/documents/portals` (#1759) used to answer with `listPortals()` /
// `listPortalAccounts()` — the whole instance-wide vocabulary — to any authorized token.
// #1791 scoped run-report VISIBILITY to profile reachability and flagged the registry as
// the remaining instance-wide surface; the owner then ruled it scoped too. An account
// NICKNAME is household information in its own right ("Mom", "Dad" name a household's
// composition), so a caller who cannot reach the profiles an account is claimed by has
// no business reading its name out of the registry.
//
// It is the SAME QUESTION as #1787's, so it gets the same computation: the predicate
// above, unchanged, applied to the registry row instead of to the run report. In
// particular clause (b) still admits an UNCLAIMED account, and here it is load-bearing
// rather than merely consistent: bindings only exist after a run has discovered a
// patient label and a human has placed it, so a portal that was just created in the UI
// is claimed by nobody. Excluding unclaimed accounts would make this endpoint unable to
// serve its own first use — `tool init` could never learn the slug of the portal it is
// being set up for, which is the entire reason #1759 exists. The population that sees
// them is unchanged: the `canManagePending` set, which is exactly the gate the endpoint
// already imposes.
//
// AN ADMIN KEEPS THE FULL REGISTRY without a special case in the code — admins reach
// every profile, so every claimed account satisfies clause (a) and every unclaimed one
// satisfies (b). "Admin sees everything" stays a property of the accessible set, not a
// second branch that could disagree with it.
//
// A PORTAL WITH NO VISIBLE ACCOUNT IS OMITTED ENTIRELY, not returned empty: a portal
// whose accounts all belong to another household is not "your portal with zero logins",
// and naming it would disclose the very thing the scoping removes. That falls out of
// reading accounts first and grouping — a portal appears only because one of its
// accounts did.
//
// The RESPONSE SHAPE is untouched. This filters rows; `buildToolConfig` still owns what
// a row may carry, so the disclosure boundary (#1759) and the reachability boundary
// stay two separate, separately-tested things.

export interface VisiblePortalRegistry {
  portals: Portal[];
  accounts: PortalAccount[];
}

// Cross-profile by construction, same contract as the reader above: already-authorized
// ids first, no lib/auth import, `profile_id IN (…)` via profileIdsIn() inside this
// registered CROSS_PROFILE_SQL_MODULES module.
export function listVisiblePortalRegistry(
  accessibleProfileIds: AuthorizedProfileIds,
  // True when the caller may also see UNCLAIMED accounts — the `canManagePending`
  // population. Passed in rather than derived, so one gate at the auth boundary decides
  // it for every surface this module serves.
  canSeeUnclaimed: boolean
): VisiblePortalRegistry {
  const ids = accessibleProfileIds;
  // One statement over accounts joined to their portal, so a portal can only appear by
  // way of an account that survived the predicate. Portal order matches listPortals()
  // (name, NOCASE); account order is left to buildToolConfig, which sorts
  // implicit-first so a tool's config file is stable.
  const rows = db
    .prepare(
      `SELECT p.id AS portalId, p.slug AS portalSlug, p.name AS portalName,
              p.software AS software, p.created_at AS portalCreatedAt,
              a.id AS accountId, a.slug AS accountSlug, a.name AS accountName,
              a.implicit AS accountImplicit, a.created_at AS accountCreatedAt
         FROM portal_accounts a
         JOIN portals p ON p.id = a.portal_id
        WHERE ${reachableAccountSql(ids, "a.id")}
        ORDER BY p.name COLLATE NOCASE, p.id, a.name COLLATE NOCASE`
    )
    .all(...ids, canSeeUnclaimed ? 1 : 0) as Record<string, unknown>[];

  const portals: Portal[] = [];
  const seenPortal = new Set<number>();
  const accounts: PortalAccount[] = rows.map((row) => {
    const portalId = row.portalId as number;
    if (!seenPortal.has(portalId)) {
      seenPortal.add(portalId);
      portals.push({
        id: portalId,
        slug: row.portalSlug as string,
        name: row.portalName as string,
        software: (row.software as PortalSoftware | null) ?? null,
        createdAt: row.portalCreatedAt as string,
      });
    }
    return {
      id: row.accountId as number,
      portalId,
      slug: row.accountSlug as string,
      name: row.accountName as string,
      implicit: (row.accountImplicit as number) === 1,
      createdAt: row.accountCreatedAt as string,
    };
  });
  return { portals, accounts };
}
