import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import { E2E_LOGIN_CONDREV } from "./fixture-logins";
import { E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Condition-suggestion review flow (#685). The CONDITION_REVIEW fixture profile owns a
// positive infection lab result ("HIV 1/2 Antibody: Reactive") that is NOT on its
// problem list, so the suggest-only review item surfaces on Upcoming with an inline
// "Add to conditions" confirm. Isolated fixture login (never a shared-seed profile);
// the spec self-heals — it removes any HIV condition a prior repeat added and cleans
// up after — so it's safe under --repeat-each.

const HIV_ITEM = "upcoming-item-condition-review:name:hiv";

// Remove any "HIV" condition currently on the problem list (RecordTable trash →
// confirm dialog). No-op when the list is clean, so it's a safe repeat-reset.
async function removeHivCondition(page: Page): Promise<void> {
  await page.goto("/conditions");
  const row = page.getByRole("row").filter({ hasText: "HIV" });
  while ((await row.count()) > 0) {
    await row.first().getByRole("button", { name: "Delete" }).click();
    await settledClick(
      page,
      page
        .getByRole("dialog")
        .getByRole("button", { name: "Delete", exact: true })
    );
    await expect(page.getByRole("row").filter({ hasText: "HIV" })).toHaveCount(
      0
    );
  }
}

test.describe("condition-suggestion review (#685)", () => {
  test("a positive infection result is confirmable into a condition from Upcoming", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_CONDREV,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // Start from the clean "suggested, not yet on the problem list" state.
      await removeHivCondition(page);

      // The suggestion surfaces on Upcoming as a condition-review item with the confirm.
      await page.goto("/upcoming");
      const item = page.getByTestId(HIV_ITEM);
      await expect(item).toBeVisible();
      await expect(item).toContainText("Add HIV to conditions?");

      // Confirm it — the Server Action creates the Condition idempotently.
      await settledClick(
        page,
        item.getByRole("button", { name: "Add to conditions" })
      );

      // It now lives on the problem list...
      await page.goto("/conditions");
      await expect(
        page.getByRole("row").filter({ hasText: "HIV" })
      ).toHaveCount(1);

      // ...and the suggestion self-clears from Upcoming (deduped by concept).
      await page.goto("/upcoming");
      await expect(page.getByTestId(HIV_ITEM)).toHaveCount(0);
    } finally {
      // Reset so the next run/repeat starts from a clean problem list.
      await removeHivCondition(page);
      await page.context().close();
    }
  });
});
