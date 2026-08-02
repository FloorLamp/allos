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

// Cross-household disclosure on the Patient portals page (#1787, tightened by #1875).
//
// The page renders each portal login's last-run report — portal name, account nickname,
// and the companion tool's free-text `message`, up to 500 characters supplied through
// the token-authenticated upload API. Before #1787 that read was instance-wide, so a
// login with access to no profile tied to the failing account still saw all three.
// #1874 moved the sentence from a page-bottom status line onto the login's own row, and
// #1875 closed the remaining crack: unclaimed accounts are admin-only, so a member sees
// a portal ONLY through a login already claimed by a profile they can reach.
//
// The seeded fixture (e2e/seed/portals.ts) is two households that share NO profile
// access. Household B owns the failing portal; household A must never learn that it
// failed, why — or, since #1875, that it exists at all.
// The failing run is planted HERE, not in the seed: seeded, it would become part of the
// shared admin session's surface and disturb the setup spec's assertions. This spec owns
// the row — planted before each of its tests, removed after, whatever the test did.
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

// A fixed DEEP-FUTURE stamp, never wall clock: it makes this the newest report the
// account can have while it exists, so the login row's status is unambiguous.
const FAILURE_AT = "2027-01-01 12:00:00";

test.describe("Patient portals status scoping (#1787/#1875)", () => {
  test.beforeEach(() => plantBeeFailure());
  test.afterEach(() => clearBeeFailure());

  test("household A never sees household B's portal, login, or failure", async ({
    browser,
  }) => {
    test.slow(); // local `next dev` compiles the route on first hit

    const member = await loginAs(browser, {
      username: E2E_LOGIN_PORTAL_A,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/integrations/patient-portals");

      // The page is not blanked — it still answers for THIS household (here: the
      // member-empty promise, since A's profile has no covering login), which is what
      // makes the fix a scoping change rather than a removal.
      await expect(member.getByTestId("portals-member-empty")).toBeVisible();

      // The FREE TEXT is asserted page-wide, because that is the disclosure: up to 500
      // characters an external companion tool supplies through the token-authenticated
      // upload API, which could name a patient or an account detail. It must not reach
      // this login through ANY element.
      await expect(member.locator("body")).not.toContainText(PORTAL_B_FAILURE);

      // The failing account's nickname names a household's composition (#1796).
      await expect(member.locator("body")).not.toContainText(PORTAL_B_ACCOUNT);

      // And since #1875 the PORTAL NAME is gone too: unclaimed accounts are admin-only,
      // so B's never-bound implicit login no longer smuggles the portal's existence to
      // every member with write access somewhere.
      await expect(member.locator("body")).not.toContainText(PORTAL_B_NAME);
    } finally {
      await member.context().close();
    }
  });

  test("household B still sees its own portal failure, on its login's row", async ({
    browser,
  }) => {
    test.slow();

    // The other half of the negative: the message is genuinely reachable, so the first
    // test is proving scoping rather than a fixture that never rendered. The sentence
    // lives on the login row now (#1874) — B's covering login is the only one B sees,
    // so its portal section renders without sub-groups and carries the status.
    const member = await loginAs(browser, {
      username: E2E_LOGIN_PORTAL_B,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/integrations/patient-portals");
      const section = member.locator(
        `[data-testid="portal-section"][data-portal-name="${PORTAL_B_NAME}"]`
      );
      await expect(section).toBeVisible();
      const status = section.getByTestId("login-status");
      await expect(status).toContainText(PORTAL_B_FAILURE);
      await expect(status).toHaveAttribute("data-tone", "attention");
    } finally {
      await member.context().close();
    }
  });
});
