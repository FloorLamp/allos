import { test, expect } from "./fixtures";
import { hydratedClick } from "./helpers";
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
//
// The confirm is reached through the Body history row's ⋯ menu. That row joined the
// shared #1491 row-action convention in #2556 (it used to carry a bare × delete and
// no edit at all), so opening this dialog is now TWO taps — the menu, then the item —
// and the item is a `menuitem`, not a `button`. The accessible name is unchanged, and
// the spec's own point is unchanged with it: any seeded history row opens the SAME
// shared ConfirmDialog, and this spec only ever cancels it.

test("the same confirm uses its desktop presentation and cancels cleanly", async ({
  page,
}) => {
  await page.goto("/trends");

  // The row's ⋯ trigger names its own entry (#2530), so the substring match finds
  // every body-history row's menu and none of the page's other controls.
  const rowActions = page.getByRole("button", {
    name: "Actions for entry from",
  });
  await expect(rowActions.first()).toBeVisible(); // first-ok: any seeded history row opens the same shared ConfirmDialog; this spec only CANCELS it

  // hydratedClick replaces the old re-tap loop: it waits for React to attach to THIS
  // node and then taps once, which is what a menu needs — a re-tap loop on a toggle
  // would close the menu it just opened.
  await hydratedClick(page, rowActions.first()); // first-ok: same row as above

  const dialog = page.getByTestId("confirm-dialog");
  await page.getByRole("menuitem", { name: "Delete entry" }).click();
  await expect(dialog).toBeVisible();

  // One primitive, one presentation mode — the viewport is the only difference.
  await expect(dialog).toHaveAttribute("data-presentation", "dialog");
  // A centered card is not flickable, so the sheet's drag handle is gone here.
  // (Present in the DOM, hidden by the primitive's own `md:hidden` — asserted as
  // hidden rather than absent, since content is authored ONCE.)
  await expect(dialog.getByTestId("sheet-drag-handle")).toBeHidden();

  // Same keyboard contract, same explicit buttons, same cancel-on-dismiss.
  await expect(dialog.getByRole("button", { name: "Delete" })).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  // The menu closed itself before the confirm opened (a cancelled confirm must not
  // leave the click-away backdrop shielding the table), so what proves the cancel
  // wrote nothing is the row still offering its actions.
  await expect(rowActions.first()).toBeVisible(); // first-ok: the same seeded row, proving the cancel wrote nothing
});
