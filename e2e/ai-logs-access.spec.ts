import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_CHILD, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Settings → AI logs (issue #391, gap 6). The AI activity log mixes extraction
// content (names, biomarkers) across every profile, so /settings/logs is admin-only
// (requireAdmin). This proves the boundary end-to-end: an admin sees the tab + the
// log surface; a member hitting the URL directly is bounced to the app root (the
// same pattern as view-only-access, one tier up at requireAdmin).
test.describe("AI logs access gate (#391)", () => {
  test("an admin sees the AI logs tab and the log surface", async ({
    page,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    await page.goto("/settings/logs");
    await expect(page.getByRole("heading", { name: "Settings" })).toBeVisible();
    // The admin-only tab is present …
    await expect(page.getByRole("link", { name: "AI logs" })).toBeVisible();
    // … and the streaming log surface renders (subtitle + the live-count row).
    await expect(page.getByText(/AI activity log/)).toBeVisible();
    await expect(page.getByText(/\d+ events/)).toBeVisible();
  });

  test("a member hitting the AI logs URL is redirected out", async ({
    browser,
  }) => {
    test.slow();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_CHILD,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/settings/logs");
      // requireAdmin bounces a member to the app root before the page renders.
      await member.waitForURL((u) => u.pathname === "/", { timeout: 20_000 });
      await expect(member.getByText(/AI activity log/)).toHaveCount(0);
    } finally {
      await member.context().close();
    }
  });
});
