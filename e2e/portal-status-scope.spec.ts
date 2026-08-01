import Database from "better-sqlite3";
import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { workerDbPath } from "./worker-env";
import {
  E2E_LOGIN_PORTAL_A,
  E2E_LOGIN_PORTAL_B,
  E2E_MEMBER_PASSWORD,
  PORTAL_B_ACCOUNT,
  PORTAL_B_FAILURE,
  PORTAL_B_NAME,
} from "./fixture-logins";

// Cross-household disclosure on the Patient portals status card (#1787).
//
// The card's Status sentence picks the globally-newest FAILED portal run report and
// renders its portal name, account nickname, and the companion tool's free-text
// `message`. That read was instance-wide, gated only by requireSession(), so a login
// with access to no profile tied to that portal account still saw all three — including
// up to 500 characters of text an external tool supplies through the token-authenticated
// upload API.
//
// The seeded fixture (e2e/seed/portals.ts) is two households that share NO profile
// access. Household B owns the failing portal; household A must never learn that it
// failed, or why.
// A holds WRITE access to its own profile, so it is in the canManagePending population —
// the widest a non-admin member can be, which makes this the strongest form of the
// negative: even the most-privileged member with no tie to the account sees nothing.
// The failing run is planted HERE, not in the seed. Seeded, it would be the only run
// report in the database — and an admin reaches every profile, so it would legitimately
// become the newest visible failure for the shared admin session and break
// patient-portals-setup.spec's first-contact assertion that the card reads exactly
// "No run reported yet.". A fixture that changes a neighbour's surface is not a fixture.
// So this spec owns the row: planted before each of its tests, removed after, whatever
// the test did. The durable scaffolding (two households, the account bound to B) stays
// in the seed, because it changes nobody's surface.
function beeAccountId(db: Database.Database): number {
  return (
    db
      .prepare(
        `SELECT a.id AS id FROM portal_accounts a
           JOIN portals p ON p.id = a.portal_id
          WHERE p.name = ? AND a.name = ?`
      )
      .get(PORTAL_B_NAME, PORTAL_B_ACCOUNT) as { id: number }
  ).id;
}

function withDb<T>(fn: (db: Database.Database) => T): T {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return fn(db);
  } finally {
    db.close();
  }
}

function plantBeeFailure(): void {
  withDb((db) => {
    const accountId = beeAccountId(db);
    db.prepare(
      `INSERT INTO portal_run_reports
         (account_id, portal_id, at, ok, status, message, discovered)
       SELECT a.id, a.portal_id, ?, 0, 'failed', ?, 0
         FROM portal_accounts a WHERE a.id = ?
       ON CONFLICT(account_id) DO UPDATE SET
         at = excluded.at, ok = excluded.ok, status = excluded.status,
         message = excluded.message, discovered = excluded.discovered`
    ).run(FAILURE_AT, PORTAL_B_FAILURE, accountId);
  });
}

function clearBeeFailure(): void {
  withDb((db) => {
    db.prepare("DELETE FROM portal_run_reports WHERE account_id = ?").run(
      beeAccountId(db)
    );
  });
}

// A fixed DEEP-FUTURE stamp, never wall clock: it makes this the newest report while it
// exists, so it is exactly the one portalStatusLine's rule 1 picks — the path the bug
// travelled.
const FAILURE_AT = "2027-01-01 12:00:00";

test.describe("Patient portals status scoping (#1787)", () => {
  test.beforeEach(() => plantBeeFailure());
  test.afterEach(() => clearBeeFailure());

  test("household A never sees household B's portal failure", async ({
    browser,
  }) => {
    test.slow(); // local `next dev` compiles the route on first hit

    const member = await loginAs(browser, {
      username: E2E_LOGIN_PORTAL_A,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/integrations/patient-portals");

      // The page is not blanked — it still answers for THIS household with its own next
      // step, which is what makes the fix a scoping change rather than a removal. What it
      // must not carry is a single trace of the other household's run.
      await expect(member.getByTestId("portal-stage")).toBeVisible();

      // The FREE TEXT is asserted page-wide, because that is the disclosure: up to 500
      // characters an external companion tool supplies through the token-authenticated
      // upload API, which could name a patient or an account detail. It must not reach
      // this login through ANY element, not just through the one that leaked it.
      await expect(member.locator("body")).not.toContainText(PORTAL_B_FAILURE);

      // THE FAILING ACCOUNT IS NEVER NAMED to this login either — the nickname is half of
      // what leaked, and it names a household's composition (#1796).
      await expect(member.locator("body")).not.toContainText(PORTAL_B_ACCOUNT);

      // Deliberately NOT asserted page-wide: the PORTAL name. #1826 narrowed the page onto
      // the scoped registry read (`listVisiblePortalRegistry`), and that read admits an
      // UNCLAIMED account — an account with no binding onto any profile — to the
      // canManagePending population, which household A is in. A portal created in the UI
      // is claimed by nobody until a run has discovered a patient on it, so clause (b) is
      // load-bearing rather than incidental, and B's portal still reaches A through its
      // never-bound implicit login. What A must not learn is that B's NAMED login failed
      // and why, which is what the assertions above cover.
    } finally {
      await member.context().close();
    }
  });

  test("household B still sees its own portal failure", async ({ browser }) => {
    test.slow();

    // The other half of the negative: the message is genuinely reachable, so the first
    // test is proving scoping rather than a fixture that never rendered. B's account has
    // a reported run, so B's page is in steady state and leads with the one status
    // sentence (#1826).
    const member = await loginAs(browser, {
      username: E2E_LOGIN_PORTAL_B,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/integrations/patient-portals");
      const status = member.getByTestId("portals-status-line");
      await expect(status).toBeVisible();
      await expect(status).toContainText(PORTAL_B_FAILURE);
      await expect(status).toContainText(PORTAL_B_NAME);
      await expect(status).toContainText(PORTAL_B_ACCOUNT);
      await expect(status).toHaveAttribute("data-tone", "attention");
    } finally {
      await member.context().close();
    }
  });
});
