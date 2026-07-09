import { test, expect } from "@playwright/test";

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
      page.getByTestId("audit-table").getByText("login.success").first()
    ).toBeVisible();
  });

  test("a member is redirected away from the audit URL", async ({
    page,
    browser,
  }) => {
    // Drives several routes (family, a fresh login, the audit page); in local
    // `next dev` each compiles on first hit, so give it the extended budget.
    test.slow();
    // Unique per run so a CI retry (same persistent DB) doesn't collide on the
    // NOCASE-unique username.
    const memberUser = `member${Date.now()}`;
    const memberPass = "member-pass-1234";

    // As admin: create a member login and grant it a profile (so it has a usable
    // session — otherwise it can't sign in at all, and we want to prove the
    // ADMIN gate specifically bounces a logged-in member).
    await page.goto("/settings/family");
    await page.getByPlaceholder("Username").fill(memberUser);
    await page.getByPlaceholder("Password").fill(memberPass);
    await page.getByRole("button", { name: "Create login" }).click();

    const grantRow = page.getByTestId(`grant-row-${memberUser}`);
    await expect(grantRow).toBeVisible();
    await grantRow.locator('input[type="checkbox"]').first().check();
    await grantRow.getByRole("button", { name: "Save access" }).click();
    await expect(grantRow.getByText("Access updated.")).toBeVisible();

    // In a fresh, explicitly cookie-less context (empty storageState, so it does
    // NOT inherit the admin session), sign in as the member.
    const memberCtx = await browser.newContext({
      storageState: { cookies: [], origins: [] },
    });
    const memberPage = await memberCtx.newPage();
    await memberPage.goto("/login");
    await memberPage.fill('input[name="username"]', memberUser);
    await memberPage.fill('input[name="password"]', memberPass);
    await memberPage.click('button[type="submit"]');
    await memberPage.waitForURL((u) => !u.pathname.startsWith("/login"), {
      timeout: 20_000,
    });

    // requireAdmin() redirects a member off the admin-only audit page to the app
    // root — the audit table is never shown.
    await memberPage.goto("/settings/audit");
    await expect(memberPage).toHaveURL(/\/$|\/\?/);
    await expect(memberPage.getByTestId("audit-table")).toHaveCount(0);

    await memberCtx.close();
  });
});
