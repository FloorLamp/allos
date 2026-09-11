import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { hydratedClick } from "./helpers";
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
    // ON THE PAGE, NOT BEHIND A FOLD (#5435 §3.1). Reopen is part of Current care
    // now — "at most one eligible, undismissed row per profile, after the open
    // episodes" — so nothing has to be opened to reach it. The rows keep the
    // identity the ranker minted for them (`illness.reopen:<profileId>:<episodeId>`,
    // through `careCandidates.illnessReopen`), which is what lets this spec and the
    // dismissal case below address them unchanged.
    const reopen = dashboardCandidatePrefix(page, "illness.reopen:");
    await expect(reopen).toHaveCount(2);
    // EACH IS AN OFFER WITH ITS OWN CONTROLS, which is what `data-kind="action"`
    // said under the ranker's four kinds. v3 has no kinds: a row either carries a
    // control or it does not, so the claim is made of the controls themselves.
    for (const situation of [
      FOLD_REOPEN_KID_A_SITUATION,
      FOLD_REOPEN_KID_B_SITUATION,
    ]) {
      const row = reopen.filter({ hasText: situation });
      await expect(
        row.getByTestId("recently-resolved-reopen-btn")
      ).toBeVisible();
      await expect(row.getByTestId("recently-resolved-dismiss")).toBeVisible();
    }

    // THE HOUSEHOLD-HISTORY DOOR IS GONE FROM THE PAGE, not merely from a fold
    // (#5435 §3.1: "the separate household-history door is removed; the episode link
    // remains"). #3366 had already dropped it from the tail and #4076 drew no door
    // row in its place; the cutover removes the fact as well, so this is the same
    // absence asked of the whole page rather than of one band — and the episode link
    // it left behind is what the rows above still carry.
    await expect(
      dashboardCandidatePrefix(page, "household.episode-history")
    ).toHaveCount(0);
    await expect(page.getByRole("main").getByText("Elsewhere")).toHaveCount(0);
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
    await expect(dashboardCandidatePrefix(tail, "illness.reopen:")).toHaveCount(
      0
    );
    // The control: Home rendered and holds rows, so the absence above is about a
    // populated page and not an empty selector. It counted the retired tail's rows
    // until #5435 §4 removed the tail; the rows it counts now are the page's own.
    expect(await tail.locator("[data-candidate-id]").count()).toBeGreaterThan(
      0
    );
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
    await expect(
      page.locator(`[data-candidate-id='${dismissedId}']`)
    ).toHaveCount(0);
    await expect(dashboardCandidatePrefix(page, "illness.reopen:")).toHaveCount(
      1
    );
  } finally {
    resetDismissals(E2E_LOGIN_FOLDREOPEN);
    await page.context().close();
  }
});
