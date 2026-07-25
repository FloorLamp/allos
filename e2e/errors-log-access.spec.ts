import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_CHILD, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Settings → Errors (issue #596). The server error log persists unexpected
// exceptions/500s (data/logs/errors.jsonl) and mixes PHI-adjacent detail across
// every profile, so /settings/errors is admin-only (requireAdmin) — the same
// boundary as the AI logs tab. This proves it end-to-end: an admin sees the tab
// and a seeded error row; a member hitting the URL directly is bounced to root.
test.describe("Server error log access gate (#596)", () => {
  test("an admin sees the Errors tab and the seeded error row", async ({
    page,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    await page.goto("/settings/errors");
    // #1462: pages are topic GROUPS, so the heading names the group (it used to be a
    // generic "Settings" over a tab strip).
    await expect(
      page.getByRole("heading", { name: "Logs & audit" })
    ).toBeVisible();
    // The admin-only sub-page entry is present …
    await expect(
      page
        .getByTestId("settings-subpage-nav")
        .getByRole("link", { name: "Errors" })
    ).toBeVisible();
    // … the error surface renders …
    await expect(page.getByText(/Unexpected exceptions/)).toBeVisible();
    await expect(page.getByTestId("error-log")).toBeVisible();
    // … and the seeded synthetic error (see e2e/seed-events.ts) is listed.
    await expect(
      page.getByText("Seeded server error for the admin errors surface")
    ).toBeVisible();
  });

  test("a member hitting the Errors URL is redirected out", async ({
    browser,
  }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_CHILD,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/settings/errors");
      // requireAdmin bounces a member to the app root before the page renders.
      await member.waitForURL((u) => u.pathname === "/", { timeout: 20_000 });
      await expect(member.getByText(/Server error log/)).toHaveCount(0);
    } finally {
      await member.context().close();
    }
  });
});
