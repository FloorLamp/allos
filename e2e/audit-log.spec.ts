import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_MEMBER_PASSWORD, E2E_LOGIN_CHILD } from "./fixture-logins";

// Settings → Audit (issue #22): the admin-only access/modification trail. The
// admin (the seed + auth.setup log in as admin, which writes a `login.success`
// audit row) can see the tab and that row; a member is redirected away from the
// URL by requireAdmin().
test.describe("Settings → Audit log", () => {
  test("admin sees the Audit tab and a login event row", async ({ page }) => {
    await page.goto("/settings/audit");

    // The admin-only tab is present in the settings tab strip.
    await expect(page.getByRole("link", { name: "Audit" })).toBeVisible();

    // The table renders; filter to the login domain and find the login.success
    // row written when auth.setup signed in as admin.
    await expect(page.getByTestId("audit-table")).toBeVisible();
    await page.goto("/settings/audit?action=login");
    await expect(
      page.getByTestId("audit-table").getByText("login.success").first() // first-ok: asserts a login.success audit entry EXISTS at all — order-agnostic presence on a growing log
    ).toBeVisible();
  });

  test("a member is redirected away from the audit URL", async ({
    browser,
  }) => {
    // Drives a fresh member login + the audit page; in local `next dev` each
    // compiles on first hit, so give it the extended budget.
    test.slow();

    // Sign in as an EXISTING seeded non-admin member (e2e/fixture-logins.ts) in a fresh,
    // cookie-less context — replacing the former runtime create-a-member-through-Family
    // flow, whose router.refresh() grant row went stale under CI load (#868). This proves
    // the ADMIN gate specifically bounces a logged-in member.
    const memberPage = await loginAs(browser, {
      username: E2E_LOGIN_CHILD,
      password: E2E_MEMBER_PASSWORD,
    });

    // requireAdmin() redirects a member off the admin-only audit page to the app
    // root — the audit table is never shown.
    await memberPage.goto("/settings/audit");
    await expect(memberPage).toHaveURL(/\/$|\/\?/);
    await expect(memberPage.getByTestId("audit-table")).toHaveCount(0);

    await memberPage.context().close();
  });
});
