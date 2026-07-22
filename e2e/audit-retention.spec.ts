import { test, expect } from "@playwright/test";
import { settledFill } from "./helpers";

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

    // settledFill: land the value in state before the Save reads it (a pre-hydration
    // fill of a controlled input reverts → Save persists the stale value — #1188).
    await settledFill(page, input, "36");
    await page.getByTestId("audit-retention-save").click();
    // Wait for the save to actually land before reloading — the server action is
    // async, so reloading straight after the click races it (the reload can fetch
    // the page before setSetting commits, showing the stale value). The SaveStatus
    // check (aria-label "Saved") appears only once the action resolves.
    await expect(card.getByLabel("Saved")).toBeVisible();

    // Reload and confirm the new window persisted (global setting).
    await page.reload();
    await expect(page.getByTestId("audit-retention-months")).toHaveValue("36");

    // Restore the default so this global setting doesn't leak into other specs.
    await settledFill(page, page.getByTestId("audit-retention-months"), "24");
    await page.getByTestId("audit-retention-save").click();
    await expect(card.getByLabel("Saved")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("audit-retention-months")).toHaveValue("24");
  });
});
