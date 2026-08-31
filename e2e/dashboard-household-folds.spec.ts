import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { hydratedClick, openDashboardAll } from "./helpers";
import { loginAs } from "./nav";
import { workerDbPath } from "./worker-env";
import { dashboardCandidatePrefix } from "./dashboard-candidate";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_FOLDREOPEN,
  E2E_LOGIN_FOLDTAIL,
  E2E_LOGIN_FOLDWELL,
  FOLD_REOPEN_KID_A_SITUATION,
  FOLD_REOPEN_KID_B_SITUATION,
} from "./fixture-logins";

// The former composite-fold assertions belonged to the retired dashboard widgets.
// The atomic contract keeps the underlying behavior: one reopen action per eligible
// episode and one household-history action during its existing 14-day window.

const PHONE = { viewport: { width: 390, height: 844 }, hasTouch: true };

function resetDismissals(username: string): void {
  const db = new Database(workerDbPath());
  db.pragma("busy_timeout = 5000");
  try {
    db.prepare(
      `DELETE FROM login_settings
        WHERE key = 'recently_resolved_dismissed'
          AND login_id = (SELECT id FROM logins WHERE username = ?)`
    ).run(username);
  } finally {
    db.close();
  }
}

test("eligible closed episodes emit independent reopen actions", async ({
  browser,
}) => {
  resetDismissals(E2E_LOGIN_FOLDREOPEN);
  const page = await loginAs(
    browser,
    {
      username: E2E_LOGIN_FOLDREOPEN,
      password: E2E_MEMBER_PASSWORD,
    },
    PHONE
  );
  try {
    await page.goto("/");
    await openDashboardAll(page);
    const reopen = dashboardCandidatePrefix(page, "illness.reopen:");
    await expect(reopen).toHaveCount(2);
    await expect(
      reopen.filter({ hasText: FOLD_REOPEN_KID_A_SITUATION })
    ).toHaveAttribute("data-kind", "action");
    await expect(
      reopen.filter({ hasText: FOLD_REOPEN_KID_B_SITUATION })
    ).toHaveAttribute("data-kind", "action");

    // The household-history fact is a link to a page the nav already carries, so the
    // tail DROPS it (#3366) — and since #4076 draws no door row in its place either
    // (owner: the Elsewhere list is "utterly useless"; the nav already names that
    // page). The fact still places, which is what keeps the exact-once contract
    // true, and that half is asserted where it can go red: the placement manifest
    // (lib/__db_tests__/dashboard-placement-manifest.test.ts).
    await expect(
      dashboardCandidatePrefix(page, "household.episode-history")
    ).toHaveCount(0);
    await expect(page.getByTestId("dashboard-all-door")).toHaveCount(0);
    await expect(
      page.getByTestId("dashboard-all-contents").getByText("Elsewhere")
    ).toHaveCount(0);
  } finally {
    await page.context().close();
  }
});

test("the household-history action follows its existing 14-day window", async ({
  browser,
}) => {
  const tail = await loginAs(
    browser,
    { username: E2E_LOGIN_FOLDTAIL, password: E2E_MEMBER_PASSWORD },
    PHONE
  );
  try {
    await tail.goto("/");
    await openDashboardAll(tail);
    await expect(dashboardCandidatePrefix(tail, "illness.reopen:")).toHaveCount(
      0
    );
    // The control: the tail rendered and holds entries, so the door's absence below
    // is about a populated tail and not an empty selector.
    expect(
      await tail.getByTestId("dashboard-all-contents").getByTestId("dashboard-candidate").count()
    ).toBeGreaterThan(0);
    await expect(tail.getByTestId("dashboard-all-door")).toHaveCount(0);
  } finally {
    await tail.context().close();
  }

  const recovered = await loginAs(
    browser,
    { username: E2E_LOGIN_FOLDWELL, password: E2E_MEMBER_PASSWORD },
    PHONE
  );
  try {
    await recovered.goto("/");
    await expect(recovered.getByRole("main")).toBeVisible();
    await expect(
      dashboardCandidatePrefix(recovered, "illness.reopen:")
    ).toHaveCount(0);
    // Past the window the fact is not gathered at all, so nothing places for it.
    await expect(
      dashboardCandidatePrefix(recovered, "household.episode-history")
    ).toHaveCount(0);
  } finally {
    await recovered.context().close();
  }
});

test("dismissing one reopen action persists without hiding its sibling", async ({
  browser,
}) => {
  resetDismissals(E2E_LOGIN_FOLDREOPEN);
  const page = await loginAs(
    browser,
    {
      username: E2E_LOGIN_FOLDREOPEN,
      password: E2E_MEMBER_PASSWORD,
    },
    PHONE
  );
  try {
    await page.goto("/");
    await openDashboardAll(page);
    const reopen = dashboardCandidatePrefix(page, "illness.reopen:");
    await expect(reopen).toHaveCount(2);
    const dismissed = reopen.filter({ hasText: FOLD_REOPEN_KID_A_SITUATION });
    const dismissedId = await dismissed.getAttribute("data-candidate-id");
    if (!dismissedId) throw new Error("reopen candidate has no identity");

    await hydratedClick(
      page,
      dismissed.getByTestId("recently-resolved-dismiss")
    );
    await expect(reopen).toHaveCount(1);

    await page.reload();
    await openDashboardAll(page);
    await expect(
      page.locator(
        `[data-testid='dashboard-candidate'][data-candidate-id='${dismissedId}']`
      )
    ).toHaveCount(0);
    await expect(dashboardCandidatePrefix(page, "illness.reopen:")).toHaveCount(
      1
    );
  } finally {
    resetDismissals(E2E_LOGIN_FOLDREOPEN);
    await page.context().close();
  }
});
