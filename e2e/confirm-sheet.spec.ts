import { test, expect } from "./fixtures";
// The DESKTOP half of the responsive confirm primitive (issue #1428, A).
//
// #1428 asks for one component that renders "centered ≥md and as a sheet below",
// content authored once. Its mobile-sheet half is pinned in
// confirm-sheet.mobile.spec.ts; this pins that the SAME dialog, at the desktop
// viewport, is still the familiar centered card it has always been — because the
// failure mode of a responsive primitive is not "it doesn't work", it is "it
// quietly regressed the OTHER viewport", which a phone-only spec cannot see.
//
// Writes nothing: it opens a confirm and cancels.

test("the same confirm renders centered — not bottom-anchored — on a desktop viewport", async ({
  page,
}) => {
  await page.goto("/trends");

  const deletes = page.getByRole("button", { name: "Delete entry" });
  await expect(deletes.first()).toBeVisible(); // first-ok: any seeded history row opens the same shared ConfirmDialog; this spec only CANCELS it

  const dialog = page.getByTestId("confirm-dialog");
  await expect(async () => {
    if (!(await dialog.isVisible())) {
      await deletes.first().click(); // first-ok: same row as above, re-tapped past the pre-hydration swallow
    }
    await expect(dialog).toBeVisible({ timeout: 1000 });
  }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] }); // topass-ok: the confirm is opened by a CLIENT handler (useConfirm) — no POST to settle on, and no other awaitable open signal

  // One primitive, one presentation mode — the viewport is the only difference.
  await expect(dialog).toHaveAttribute("data-presentation", "dialog");
  // A centered card is not flickable, so the sheet's drag handle is gone here.
  // (Present in the DOM, hidden by the primitive's own `md:hidden` — asserted as
  // hidden rather than absent, since content is authored ONCE.)
  await expect(dialog.getByTestId("sheet-drag-handle")).toBeHidden();

  const panel = dialog.getByRole("dialog");
  const box = await panel.boundingBox();
  const viewport = page.viewportSize();
  expect(box, "the confirm panel should be laid out").not.toBeNull();
  expect(viewport, "the chromium project sets a viewport").not.toBeNull();
  // Vertically centered: a real gap below it, which is exactly what the mobile
  // spec asserts the ABSENCE of.
  expect(viewport!.height - (box!.y + box!.height)).toBeGreaterThan(40);
  expect(box!.y).toBeGreaterThan(40);
  // Horizontally centered within a pixel or two of rounding.
  const centerOffset = Math.abs(box!.x + box!.width / 2 - viewport!.width / 2);
  expect(centerOffset).toBeLessThan(3);

  // Same keyboard contract, same explicit buttons, same cancel-on-dismiss.
  await expect(dialog.getByRole("button", { name: "Delete" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(deletes.first()).toBeVisible(); // first-ok: the same seeded row, proving the cancel wrote nothing
});
