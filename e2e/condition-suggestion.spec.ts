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

// A generous per-assertion budget: this spec runs after a Server-Action-heavy
// setup (delete-reset → confirm → revalidate) and its findings are recomputed
// server-side on each navigation, so a slow CI runner can push a server-rendered
// item/row past Playwright's 5s expect default (the #920 CI double-fail). Every
// wait below is auto-retrying, so a wider ceiling only helps a slow box — it never
// slows the happy path.
const WAIT = 15_000;

// Remove any "HIV" condition currently on the problem list (RecordTable trash →
// confirm dialog). No-op when the list is clean, so it's a safe repeat-reset.
async function removeHivCondition(page: Page): Promise<void> {
  await page.goto("/records/problems");
  // Re-query the HIV rows each iteration (lazy locator) so a click never targets a
  // row detached by the prior delete's revalidate.
  const hivRows = () => page.getByRole("row").filter({ hasText: "HIV" });
  while ((await hivRows().count()) > 0) {
    // Open the row's confirm dialog and WAIT for it to mount before driving its
    // confirm — a raw click on a not-yet-ready dialog can miss on a slow runner.
    const trash = hivRows().first().getByRole("button", { name: "Delete" }); // first-ok: loop deletes EVERY HIV row; first-of-remaining is order-agnostic
    await expect(trash).toBeVisible({ timeout: WAIT });
    await trash.click();
    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible({ timeout: WAIT });
    await settledClick(
      page,
      dialog.getByRole("button", { name: "Delete", exact: true })
    );
    await expect(hivRows()).toHaveCount(0, { timeout: WAIT });
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
      await expect(item).toBeVisible({ timeout: WAIT });
      await expect(item).toContainText("Add HIV to conditions?", {
        timeout: WAIT,
      });

      // Confirm it — the Server Action creates the Condition idempotently.
      await settledClick(
        page,
        item.getByRole("button", { name: "Add to conditions" })
      );

      // Wait for the confirm's revalidation to land IN PLACE: the suggestion
      // self-clears from Upcoming (the condition is now on the problem list, so the
      // finding recomputes away). This is the durable-write gate — asserting it
      // BEFORE navigating away is what makes /conditions race-free. `goto` renders
      // the target page ONCE; if the write landed only AFTER that render, a
      // subsequent toHaveCount just re-polls stale DOM forever (the #920 flake:
      // "received 0", 34 polls). Waiting for the in-place clear proves the row is
      // committed before we read it.
      await expect(item).toHaveCount(0, { timeout: WAIT });

      // It now lives on the problem list...
      await page.goto("/records/problems");
      await expect(
        page.getByRole("row").filter({ hasText: "HIV" })
      ).toHaveCount(1, { timeout: WAIT });

      // ...and stays cleared from Upcoming on a fresh load (deduped by concept).
      await page.goto("/upcoming");
      await expect(page.getByTestId(HIV_ITEM)).toHaveCount(0, {
        timeout: WAIT,
      });
    } finally {
      // Reset so the next run/repeat starts from a clean problem list.
      await removeHivCondition(page);
      await page.context().close();
    }
  });
});
