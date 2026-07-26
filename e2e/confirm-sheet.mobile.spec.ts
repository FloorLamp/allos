import { test, expect } from "./fixtures";
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

test("a confirm opens as a thumb-reachable sheet and cancels cleanly", async ({
  page,
}) => {
  await page.goto("/trends?tab=body&view=all");

  // The seeded body-metrics history is the nearest guaranteed confirm on a
  // read-only surface. Any row's delete opens the same shared dialog.
  //
  // `view=all` is required at phone width: since #1067 the Body tab defaults to
  // the tile grid on mobile, and the History card (with its delete controls)
  // lives in the classic chart stack — the same reason trends-body-mobile.spec.ts
  // pins its anchors to that view.
  const deletes = page.getByRole("button", { name: "Delete entry" });
  await expect(deletes.first()).toBeVisible(); // first-ok: any seeded history row opens the same shared ConfirmDialog; this spec only CANCELS it, so which row is irrelevant

  const dialog = page.getByTestId("confirm-dialog");
  await expect(dialog).toHaveCount(0);

  await expect(async () => {
    if (!(await dialog.isVisible())) {
      await deletes.first().click(); // first-ok: same row as above — re-tapping the same delete past the pre-hydration swallow
    }
    await expect(dialog).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] }); // topass-ok: the confirm is opened by a CLIENT handler (useConfirm), so a pre-hydration tap is swallowed with no POST to settle on and no other awaitable signal

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
  await expect(deletes.first()).toBeVisible(); // first-ok: the same seeded row, proving cancel was a no-op
});

test("Escape and the backdrop both cancel the confirm sheet", async ({
  page,
}) => {
  await page.goto("/trends?tab=body&view=all");
  const deletes = page.getByRole("button", { name: "Delete entry" });
  const dialog = page.getByTestId("confirm-dialog");

  await expect(async () => {
    if (!(await dialog.isVisible())) {
      await deletes.first().click(); // first-ok: any seeded history row opens the same shared dialog; cancel-only, so the row is irrelevant
    }
    await expect(dialog).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] }); // topass-ok: client-handler dialog, no POST to settle on past the pre-hydration swallow

  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await expect(async () => {
    if (!(await dialog.isVisible())) {
      await deletes.first().click(); // first-ok: as above
    }
    await expect(dialog).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] }); // topass-ok: as above

  // Dismissal means CANCEL, mirroring window.confirm()'s boolean contract — the
  // transactional lifecycle that earns a confirm the sheet in the first place.
  await dialog.getByTestId("confirm-dialog-backdrop").click();
  await expect(dialog).toHaveCount(0);
  await expect(deletes.first()).toBeVisible(); // first-ok: the same seeded row, proving both dismissals were no-ops
});
