import { test, expect } from "./fixtures";
import { hydratedClick } from "./helpers";
import type { Locator, Page } from "@playwright/test";
// The confirm dialog presents as a BOTTOM SHEET on a phone (issue #1428, A).
//
// Why this is a real regression class: a confirm is a DECISION, and it used to
// open pinned near the top of the screen (`mt-[10vh]`) — the one place a
// one-handed phone user cannot reach. It now renders through the SHARED
// BottomSheet primitive, so its buttons sit above the safe-area inset in thumb
// range and the modality matches the quick-log sheet: one system, not two
// accidents. The desktop half (still a centered card) is pinned by the sibling
// desktop spec, confirm-sheet.spec.ts — the pair together is what proves "one
// responsive primitive, not a fork".
//
// Fixture hygiene (#868): this spec writes NOTHING. It opens a confirm and
// CANCELS, which is read-only by construction, so it can share the seeded admin
// session with every other spec at any parallelism without contending.

function firstReadingAction(page: Page): Locator {
  return page
    .getByTestId("metric-readings-table")
    .locator("tbody tr")
    .first() // first-ok: any seeded metric reading opens the same shared ConfirmDialog; every test cancels it
    .getByRole("button", { name: "Reading actions" });
}

async function openReadingDeleteConfirm(
  page: Page,
  action: Locator
): Promise<Locator> {
  await hydratedClick(page, action);
  const deleteItem = page.getByRole("menuitem", { name: "Delete" });
  await expect(deleteItem).toBeVisible();
  await hydratedClick(page, deleteItem);
  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toBeVisible();
  return dialog;
}

test("a confirm opens as a thumb-reachable sheet and cancels cleanly", async ({
  page,
}) => {
  await page.goto("/trends/metric/weight");

  // Mobile Body is intentionally tiles-only. Metric details are the phone's
  // route to the complete reading history and its row actions.
  const readingAction = firstReadingAction(page);
  await expect(readingAction).toBeVisible();

  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
  const dialog = await openReadingDeleteConfirm(page, readingAction);

  // It is the shared responsive primitive, presenting in its sheet mode…
  await expect(dialog).toHaveAttribute("data-presentation", "dialog");
  // …with the drag-handle affordance that makes a surface read as a sheet.
  await expect(dialog.getByTestId("sheet-drag-handle")).toBeVisible();

  // THE assertion: the panel is anchored to the BOTTOM of the viewport, which is
  // what puts its buttons in thumb range. Asserted by geometry, because "visible"
  // is true of a dialog parked at the top too — that was the bug.
  const panel = dialog.getByRole("dialog");
  await expect(panel).toBeVisible();
  const box = await panel.boundingBox();
  const viewport = page.viewportSize();
  expect(box, "the confirm panel should be laid out").not.toBeNull();
  expect(viewport, "the mobile project sets a viewport").not.toBeNull();
  // Its bottom edge sits at the bottom of the screen (allowing a pixel of
  // rounding), and it does NOT start in the top third the way the old centered
  // card did.
  expect(box!.y + box!.height).toBeGreaterThanOrEqual(viewport!.height - 1);
  expect(box!.y).toBeGreaterThan(viewport!.height / 3);

  // The confirm button is focused on open, so Enter answers it — the keyboard
  // contract survived the move onto the shared primitive.
  await expect(dialog.getByRole("button", { name: "Delete" })).toBeFocused();

  // Explicit buttons for a destructive confirm — never a gesture (#1425).
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
  // Cancelling wrote nothing: the row is still there.
  await expect(readingAction).toBeVisible();
});

test("Escape and the backdrop both cancel the confirm sheet", async ({
  page,
}) => {
  await page.goto("/trends/metric/weight");
  const readingAction = firstReadingAction(page);
  let dialog = await openReadingDeleteConfirm(page, readingAction);

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  dialog = await openReadingDeleteConfirm(page, readingAction);

  // Dismissal means CANCEL, mirroring window.confirm()'s boolean contract — the
  // transactional lifecycle that earns a confirm the sheet in the first place.
  await dialog.getByTestId("confirm-dialog-backdrop").click();
  await expect(dialog).toHaveCount(0);
  await expect(readingAction).toBeVisible();
});
