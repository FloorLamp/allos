import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";

// Close the care-plan loop on appointment completion (issue #658): completing a
// visit OFFERS to close the open care-plan items it matches (by kind/title/date
// window), one click each — confirm-first, never a silent auto-complete. This drives
// the real UI: add an open "colonoscopy" care-plan item, book + complete a matching
// colonoscopy appointment, then take the offer and see the item close.
const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";
const ITEM = "E2E offer colonoscopy screening";
const APPT = "E2E offer colonoscopy";

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    handle
      .prepare("DELETE FROM care_plan_items WHERE description = ?")
      .run(ITEM);
    handle.prepare("DELETE FROM appointments WHERE title = ?").run(APPT);
  } finally {
    handle.close();
  }
}

test.describe("Care-plan close-the-loop on appointment completion (#658)", () => {
  test.beforeAll(cleanup);
  test.afterAll(cleanup);

  test("completing a matching appointment offers to close the care-plan item", async ({
    page,
  }) => {
    test.slow();

    // Add an OPEN care-plan item (undated intentions still match — the matcher
    // only date-gates DATED items).
    await page.goto("/records/care/overview");
    await page.locator("#cp-desc-new").fill(ITEM);
    await page.locator("#cp-status-new").fill("planned");
    // Scope the "Add" to the Care plan section — the merged Health record page
    // (#1042 phase 6) has one "Add" per section.
    await page
      .getByTestId("records-care-plan")
      .getByRole("button", { name: "Add", exact: true })
      .click();
    await expect(page.getByText("Care-plan item saved")).toBeVisible();

    // Book a matching colonoscopy appointment (defaults to today → scheduled).
    await page.goto("/records/history/visits");
    const upcoming = page.getByTestId("visits-upcoming");
    await upcoming.getByLabel("Reason / title").fill(APPT);
    await upcoming.getByLabel("Kind (optional)").selectOption("screening");
    await upcoming.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Appointment saved")).toBeVisible();

    // Complete it — the close-the-loop panel appears.
    const row = upcoming
      .getByTestId("appointment-row")
      .filter({ hasText: APPT });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Mark completed" }).click();

    // The care-plan offer lists the matching item; take it. Click the button in
    // OUR item's own row — the offer can also list other matching open items
    // (the seed's "Repeat screening colonoscopy" matches the same needle and
    // date window), and a bare .first() closed the seeded item instead, breaking
    // care-plan.spec.ts downstream (fixture blast radius).
    const offer = upcoming.getByTestId("care-plan-offer");
    await expect(offer).toBeVisible();
    await expect(offer).toContainText(ITEM);
    await offer
      .locator("div")
      .filter({ hasText: ITEM })
      .getByTestId("care-plan-offer-done")
      .click();
    await expect(page.getByText("Care-plan item marked done")).toBeVisible();

    // The item is now closed on the care-plan page.
    await page.goto("/records/care/overview");
    await expect(page.locator("tr").filter({ hasText: ITEM })).toContainText(
      "Completed"
    );
  });
});
