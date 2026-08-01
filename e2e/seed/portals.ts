// e2e seed fixtures — patient-portals domain. Composed (in order) by e2e/seed-events.ts,
// which stays the entrypoint the Playwright webServer runs. Add a fixture for THIS
// domain here (a new exported seed function, or inside an existing one) so two PRs
// touching different domains stop colliding on one file — see the entrypoint header.

import "../../scripts/load-env";

import {
  accountsForPortal,
  bindPortalIdentity,
  createPortal,
  createPortalAccount,
  portalBySlug,
} from "../../lib/portals";
import {
  E2E_LOGIN_PORTAL_A,
  E2E_LOGIN_PORTAL_B,
  E2E_LOGIN_PORTAL_NONE,
  PORTAL_B_ACCOUNT,
  PORTAL_B_NAME,
  PORTAL_HOUSEHOLD_A_PROFILE,
  PORTAL_HOUSEHOLD_B_PROFILE,
} from "../fixture-logins";
import { fixtureProfileId, seedMemberLogin } from "./common";

// ── #1787: two households that share no profile access ──────────────────────
//
// The Patient portals status card renders the globally-newest FAILED run report's
// portal name, account nickname, and the companion tool's free-text message. Before the
// fix that read was instance-wide, so household A saw household B's failure — a
// cross-household disclosure of operator-supplied free text.
//
// This seeds exactly that: B's portal, B's named login, a binding onto B's profile only,
// and a failed run carrying the canary message. A holds write access to its own profile
// and none to B's, which also puts A in the canManagePending population — the widest a
// non-admin can be, so the spec proves the leak is closed for the most-privileged member
// who still has no tie to that account.
export function seedPortalHouseholds(): void {
  const profileA = fixtureProfileId(PORTAL_HOUSEHOLD_A_PROFILE);
  const profileB = fixtureProfileId(PORTAL_HOUSEHOLD_B_PROFILE);
  seedMemberLogin(E2E_LOGIN_PORTAL_A, profileA, "write");
  seedMemberLogin(E2E_LOGIN_PORTAL_B, profileB, "write");
  // A third login on household A's profile with READ access only. It reaches no portal
  // account — A's profile carries no binding, and a read-only member is outside the
  // canManagePending population that may see unclaimed accounts — so its visible registry
  // (#1796) is empty by construction, whatever other specs create and remove meanwhile.
  // That is what makes the guided page's empty-registry stage (#1826) assertable.
  seedMemberLogin(E2E_LOGIN_PORTAL_NONE, profileA, "read");

  // Idempotent across a reused dev server: createPortal mints a slug from the name and
  // would mint a SECOND portal on a re-run, so reuse the existing one when it is there.
  const existing = portalBySlug("bee-clinic-portal-e2e");
  let portalId: number;
  if (existing) {
    portalId = existing.id;
  } else {
    const created = createPortal(PORTAL_B_NAME);
    if (!created.ok) {
      throw new Error(`e2e portal seed failed: ${created.error}`);
    }
    portalId = created.id;
  }

  // A NAMED login, not the implicit one — the card only prints the account nickname
  // once a portal has a login worth naming, and the nickname is half of what leaked.
  let account = accountsForPortal(portalId).find(
    (a) => a.name === PORTAL_B_ACCOUNT
  );
  if (!account) {
    const made = createPortalAccount(portalId, PORTAL_B_ACCOUNT);
    if (!made.ok) {
      throw new Error(`e2e portal account seed failed: ${made.error}`);
    }
    account = accountsForPortal(portalId).find((a) => a.id === made.id)!;
  }

  // Bound to household B ONLY. This is what makes the account unreachable for A: it is
  // claimed, so it is not the unclaimed first-contact case either.
  bindPortalIdentity(account.id, "Bee Patient (e2e)", profileB);

  // NO run report is seeded. It would be the only one in the database, and an ADMIN
  // reaches every profile — so it would legitimately become the newest visible failure
  // for the shared admin session, and patient-portals-setup.spec's first-contact test
  // asserts that session sees exactly "No run reported yet.". A fixture that changes a
  // neighbour's surface is not a fixture, so the failing run is planted by
  // portal-status-scope.spec inside its own test and removed in a finally. What is
  // seeded here is only the durable scaffolding: two households, and the portal account
  // bound to one of them.

  console.log(
    `e2e: seeded portal households — A ${profileA} (${E2E_LOGIN_PORTAL_A}), ` +
      `B ${profileB} (${E2E_LOGIN_PORTAL_B}) with ${PORTAL_B_NAME} bound to B (#1787)`
  );
}
