import { db } from "@/lib/db";
import { profileIdsIn } from "@/lib/cross-profile";
import type { PortalRunReport } from "@/lib/portals";
import type { SyncReportStatus } from "@/lib/acquirer-identity";

// WHO MAY SEE A PORTAL ACCOUNT'S RUN REPORT (#1787).
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
// THE RULE. A run report is visible to a login when the ACCOUNT it belongs to is:
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

// Cross-profile by construction: the caller resolves the accessible set at the auth
// boundary and hands it in as already-authorized ids, and this module never imports
// lib/auth — the cross-profile reader convention. The `profile_id IN (…)` list is built
// with profileIdsIn(), and this module is registered in CROSS_PROFILE_SQL_MODULES.
export function listVisiblePortalRunReports(
  accessibleProfileIds: readonly number[],
  // True when the viewer may also see UNCLAIMED accounts — the `canManagePending`
  // population (admin, or write access to at least one profile). Passed in rather than
  // derived so the page's one gate decides it once for both surfaces.
  canSeeUnclaimed: boolean
): PortalRunReport[] {
  const ids = [...accessibleProfileIds];
  // An empty accessible set makes clause (a) match nothing. `profileIdsIn([])` renders
  // `(NULL)`, which is the correct empty-set semantics for SQL `IN`, so this still runs
  // as one statement rather than needing a short-circuit — and a login with no
  // accessible profile is exactly the reader the bug exposed the most to.
  const rows = db
    .prepare(
      `SELECT r.portal_id AS portalId, p.slug AS portalSlug, p.name AS portalName,
              r.account_id AS accountId, a.slug AS accountSlug, a.name AS accountName,
              a.implicit AS accountImplicit, r.at AS at, r.ok AS ok,
              r.status AS status, r.message AS message, r.discovered AS discovered
         FROM portal_run_reports r
         JOIN portals p ON p.id = r.portal_id
         JOIN portal_accounts a ON a.id = r.account_id
        WHERE EXISTS (
                SELECT 1 FROM portal_identities i
                 WHERE i.account_id = r.account_id
                   AND i.profile_id IN ${profileIdsIn(ids)}
              )
           OR (
                ? = 1
                AND NOT EXISTS (
                  SELECT 1 FROM portal_identities i2
                   WHERE i2.account_id = r.account_id
                     AND i2.profile_id IS NOT NULL
                )
              )
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
  }));
}
