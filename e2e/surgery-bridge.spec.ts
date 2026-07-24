import { test, expect } from "@playwright/test";
import { settledClick } from "./helpers";

// Pre-surgery / Post-op suggest-only bridge (#1299): the producer for the #1296 pause.
// This spec OWNS its fixtures (create-and-clean): it schedules a surgical visit a few
// days out, then asserts the Nutrition → Supplements situations bar surfaces the
// suggestion chip ("activate Pre-surgery"), confirming activates the Pre-surgery
// situation. It cancels every visit it scheduled and deactivates Pre-surgery afterward
// so the shared-seed profile is left unchanged (robust across --repeat-each).

const VISIT_TITLE = "E2E Arthroscopy";

function isoInDays(days: number): string {
  const d = new Date(Date.now() + days * 86_400_000);
  return d.toISOString().slice(0, 10);
}

// Cancel every still-scheduled visit this spec created (best-effort, loop until none
// remain) so repeated runs on the same seeded DB don't accumulate surgical visits.
async function cancelOurVisits(page: import("@playwright/test").Page) {
  await page.goto("/records/history/visits");
  for (let i = 0; i < 6; i++) {
    const cancelBtn = page
      .getByTestId("appointment-row")
      .filter({ hasText: VISIT_TITLE })
      .getByRole("button", { name: "Cancel appointment" })
      .first(); // first-ok: loop-cancel of the visits THIS spec scheduled (unique title)
    if ((await cancelBtn.count()) === 0) break;
    await settledClick(page, cancelBtn);
  }
}

test("a scheduled surgical visit suggests activating Pre-surgery", async ({
  page,
}) => {
  test.slow();

  // Start clean (a prior repeat may have left visits) so the held-count copy is stable.
  await cancelOurVisits(page);

  // ── Schedule a surgical visit a few days out (inside the 7-day lead) ─────────
  await page.goto("/records/history/visits");
  const addCard = page.getByTestId("visits-add");
  await expect(addCard).toBeVisible();
  // A future date keeps the entry on the appointment (scheduling) branch.
  await addCard.getByLabel("Date", { exact: true }).fill(isoInDays(3));
  // Dismiss the DateField popover so it can't float over the title / Add button.
  await page.keyboard.press("Escape");
  await addCard.getByLabel("Reason / title").fill(VISIT_TITLE);
  await settledClick(
    page,
    addCard.getByRole("button", { name: "Add", exact: true })
  );

  // ── The bridge chip appears on the Supplements situations bar ───────────────
  await page.goto("/nutrition?tab=supplements");
  const chip = page.locator('[data-testid^="surgery-bridge-pre-"]').first(); // first-ok: the pre-surgery chip for the single visit this spec just scheduled
  await expect(chip).toBeVisible();
  await expect(chip).toContainText("activate Pre-surgery");

  // Confirm → Pre-surgery becomes active.
  await settledClick(
    page,
    chip.getByRole("button", { name: "Activate Pre-surgery" })
  );
  await expect(
    page
      .getByTestId("situations-bar")
      .getByRole("button", { name: "Pre-surgery", exact: true })
  ).toHaveAttribute("aria-pressed", "true");

  // ── Clean up: deactivate Pre-surgery, cancel the visit(s) ───────────────────
  await settledClick(
    page,
    page
      .getByTestId("situations-bar")
      .getByRole("button", { name: "Pre-surgery", exact: true })
  );
  await cancelOurVisits(page);
});
