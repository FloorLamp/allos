import { test, expect } from "@playwright/test";

// The admin Server settings page exposes the configurable audit-log retention
// window (issue #98): a generous 24-month default the hourly notify tick prunes
// `audit_events` against, editable by an admin. The e2e DB boots with no override,
// so it shows the default; saving a new value persists across a reload.
test.describe("Settings → Server: audit-log retention", () => {
  test("shows the default and persists an edited retention window", async ({
    page,
  }) => {
    await page.goto("/settings/server");

    const card = page.getByTestId("audit-retention-settings");
    await expect(card).toBeVisible();

    const input = page.getByTestId("audit-retention-months");
    // Default is the generous 24-month window (no setting stored in the e2e DB).
    await expect(input).toHaveValue("24");

    await input.fill("36");
    await page.getByTestId("audit-retention-save").click();

    // Reload and confirm the new window persisted (global setting).
    await page.reload();
    await expect(page.getByTestId("audit-retention-months")).toHaveValue("36");

    // Restore the default so this global setting doesn't leak into other specs.
    await page.getByTestId("audit-retention-months").fill("24");
    await page.getByTestId("audit-retention-save").click();
    await page.reload();
    await expect(page.getByTestId("audit-retention-months")).toHaveValue("24");
  });
});
