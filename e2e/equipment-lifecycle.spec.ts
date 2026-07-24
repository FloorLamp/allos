import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";

const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";
const NAME = "E2E Trap Bar";

// Repeat-safe (#868): the add rejects a duplicate name (app/(app)/equipment/actions.ts
// — "You already have equipment named …"), so a --repeat-each iteration that re-added
// this marker would get that error instead of "Equipment added" and hang the first
// assert. Delete just this marker (scoped, like imaging.spec) before + after every run.
function cleanup() {
  const db = new Database(DB_PATH);
  try {
    db.prepare("DELETE FROM equipment WHERE name = ?").run(NAME);
  } finally {
    db.close();
  }
}

// #341: equipment lifecycle. The equipment manager (now the /equipment registry
// index — issue #343) gains a Retire/Restore toggle (soft-retire, mirroring dose
// retire) alongside the existing edit/delete, and the Type picker offers the
// expanded, grouped category set. This drives the manager: add a piece of gear,
// retire it (it stays listed with a "Retired" badge), then restore it — proving
// the round-trip renders on the real page.
test.beforeEach(cleanup);
test.afterEach(cleanup);

test("retire and restore equipment from the manager (#341)", async ({
  page,
}) => {
  await page.goto("/equipment");

  await expect(
    page.getByRole("heading", { name: "Your equipment" })
  ).toBeVisible();

  // Add a distinctive, synthetic implement.
  await page.getByRole("button", { name: "Add equipment" }).click();
  await page.getByLabel("Name").fill("E2E Trap Bar");
  // The expanded category set is grouped; Kettlebell is one of the new strength
  // options, proving the enum expansion reached the UI.
  await page.getByLabel("Type").selectOption("Kettlebell");
  await page.getByRole("button", { name: "Save" }).click();
  await expect(page.getByText("Equipment added")).toBeVisible();

  const row = page
    .getByTestId("equipment-row")
    .filter({ hasText: "E2E Trap Bar" });
  await expect(row).toBeVisible();
  await expect(row).toHaveAttribute("data-retired", "0");

  // Retire it — the row stays listed (history-preserving) but flips to retired and
  // shows the badge.
  await row.getByTestId("equipment-retire-toggle").click();
  await expect(page.getByText("Retired E2E Trap Bar")).toBeVisible();
  const retiredRow = page
    .getByTestId("equipment-row")
    .filter({ hasText: "E2E Trap Bar" });
  // Badge/attr flips on the toggle form's router.refresh() — cold-shard budget (imaging precedent).
  await expect(retiredRow).toHaveAttribute("data-retired", "1", {
    timeout: 15_000,
  });
  await expect(retiredRow.getByText("Retired")).toBeVisible();

  // Restore it.
  await retiredRow.getByTestId("equipment-retire-toggle").click();
  await expect(page.getByText("Restored E2E Trap Bar")).toBeVisible();
  await expect(
    page.getByTestId("equipment-row").filter({ hasText: "E2E Trap Bar" })
  ).toHaveAttribute("data-retired", "0", { timeout: 15_000 });
});
