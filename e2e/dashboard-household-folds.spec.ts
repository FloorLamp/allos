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
    // tail draws the PAGE as a door instead of a card of its own (#3366) — the fact
    // still places, which is what keeps the exact-once contract true.
    await expect(
      dashboardCandidatePrefix(page, "household.episode-history")
    ).toHaveCount(0);
    const door = page.locator(
      '[data-testid="dashboard-all-door"][data-door-href="/medical/episodes"]'
    );
    await expect(door).toHaveCount(1);
    await expect(door).toHaveAttribute("href", "/medical/episodes");
    await expect(door).toHaveText("Illness episodes");
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
    await expect(
      tail.locator(
        '[data-testid="dashboard-all-door"][data-door-href="/medical/episodes"]'
      )
    ).toHaveCount(1);
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
    // Past the window the fact is not gathered at all, so neither a card nor a door.
    await expect(
      recovered.locator(
        '[data-testid="dashboard-all-door"][data-door-href="/medical/episodes"]'
      )
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
