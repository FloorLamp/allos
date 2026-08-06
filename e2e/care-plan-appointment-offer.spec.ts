import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { workerDbPath } from "./worker-env";
import { settledSelect } from "./helpers";

// Close the care-plan loop on appointment completion (issue #658): completing a
// visit OFFERS to close the open care-plan items it matches (by kind/title/date
// window), one click each — confirm-first, never a silent auto-complete. This drives
// the real UI: add an open "colonoscopy" care-plan item, book + complete a matching
// colonoscopy appointment, then take the offer and see the item close.
const DB_PATH = workerDbPath();
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
    await page.goto("/records/care/overview#care-plan");
    await page.getByTestId("add-care-plan-panel-toggle").click();
    const carePlanDialog = page.getByRole("dialog", {
      name: "Add care-plan item",
    });
    await carePlanDialog.locator("#cp-desc-new").fill(ITEM);
    // Status is an enum picker since #1676.
    await settledSelect(
      page,
      carePlanDialog.locator("#cp-status-new"),
      "planned"
    );
    // Scope the "Add" to the Care plan section — the merged Health record page
    // (#1042 phase 6) has one "Add" per section.
    await carePlanDialog
      .getByRole("button", { name: "Add", exact: true })
      .click();
    await expect(page.getByText("Care-plan item saved")).toBeVisible();

    // Book a matching colonoscopy appointment (defaults to today → scheduled).
    await page.goto("/records/history/visits");
    await page.getByTestId("add-visit-panel-toggle").click();
    const visitDialog = page.getByRole("dialog", { name: "Add visit" });
    const upcoming = page.getByTestId("visits-upcoming");
    await visitDialog.getByLabel("Reason / title").fill(APPT);
    await visitDialog.getByLabel("Kind (optional)").selectOption("screening");
    await visitDialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Appointment saved")).toBeVisible();

    // Complete it — the close-the-loop panel appears.
    const row = upcoming
      .getByTestId("appointment-row")
      .filter({ hasText: APPT });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole("button", { name: "Mark completed" }).click();

    // The care-plan offer lists the matching item; take it. Click the button in
    // OUR item's own row — the offer can also list other matching open items
    // (the seed's "Repeat screening colonoscopy" matches the same needle and
    // date window), and a bare first-match closed the seeded item instead, breaking
    // care-plan.spec.ts downstream (fixture blast radius).
    const offer = upcoming.getByTestId("care-plan-offer");
    await expect(offer).toBeVisible();
    await expect(offer).toContainText(ITEM);
    await offer
      .locator("div")
      .filter({ hasText: ITEM })
      .getByTestId("care-plan-offer-done")
      .click();
    // The toast wording comes from the write's typed outcome now (#2140) — the
    // same carePlanDoneResult phrase the Upcoming "Mark done" chip renders.
    await expect(page.getByText("Marked done")).toBeVisible();

    // The item is now closed on the care-plan page.
    await page.goto("/records/care/overview#care-plan");
    await expect(page.locator("tr").filter({ hasText: ITEM })).toContainText(
      "Completed"
    );
  });
});
