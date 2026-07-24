import { test, expect } from "@playwright/test";
import { settledClick } from "./helpers";

// Pre-surgery / Post-op suggest-only bridge (#1299): the producer for the #1296 pause.
// This spec OWNS its fixtures (create-and-clean): it schedules a surgical visit for
// today, then asserts the Nutrition → Supplements situations bar surfaces the
// suggestion chip ("activate Pre-surgery"), confirming activates the Pre-surgery
// situation. It cancels every visit it scheduled and deactivates Pre-surgery afterward
// so the shared-seed profile is left unchanged (robust across --repeat-each).

const VISIT_TITLE = "E2E Arthroscopy";

// Cancel every still-scheduled visit this spec created (loop until none remain) so
// repeated runs on the same seeded DB don't accumulate surgical visits. Uses a plain
// click + a retrying count-decrement (not settledClick, whose armed POST-wait races the
// cancel's `startTransition` server action in fast production timing) — the row leaves
// the upcoming section once its status settles to Cancelled.
async function cancelOurVisits(page: import("@playwright/test").Page) {
  await page.goto("/records/history/visits");
  const cancelBtns = page
    .getByTestId("appointment-row")
    .filter({ hasText: VISIT_TITLE })
    .getByRole("button", { name: "Cancel appointment" });
  for (let n = await cancelBtns.count(); n > 0; n--) {
    await cancelBtns.first().click(); // first-ok: loop-cancel of the visits THIS spec scheduled (unique title)
    await expect(cancelBtns).toHaveCount(n - 1);
  }
}

test("a scheduled surgical visit suggests activating Pre-surgery", async ({
  page,
}) => {
  test.slow();

  // Start clean (a prior repeat may have left visits) so the held-count copy is stable.
  await cancelOurVisits(page);

  // ── Schedule a surgical visit for TODAY (the form's default date) ───────────
  // Leave the DateField untouched: it defaults to the app's frozen "today", which is
  // both a scheduled (non-past → appointment branch) visit AND trivially inside the
  // 7-day lead window (0 days out). Deriving the date in the browser (isoInDays) would
  // race the app's frozen/pinned-timezone clock in CI and mis-place the visit — the
  // whole "date defaults to today" pattern the visits specs use avoids that.
  await page.goto("/records/history/visits");
  const addCard = page.getByTestId("visits-add");
  await expect(addCard).toBeVisible();
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
