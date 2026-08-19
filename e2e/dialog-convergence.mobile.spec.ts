import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { hydratedClick, touchSwipe, touchSwipeFrom } from "./helpers";

// The #2774 convergence, from the outside: ModalShell's consumers now render the
// ONE responsive dialog primitive, so on a phone they are sheets that OWN THE
// VIEWPORT.
//
// THE DEFECT THIS RETIRES. ModalShell rendered `fixed inset-0 overflow-y-auto`
// and scrolled itself over an UNLOCKED body, so a drag its own scroller did not
// claim chained out to the document: the page slid around behind the dialog and
// on release sat somewhere other than where the dialog was opened from. That is
// what the first test pins, and it pins it the only way that means anything —
// by moving the page, not by reading a class off an element. A test that opened
// a dialog and asserted it rendered would answer a much cheaper question.
//
// Fixture hygiene (#868): every test here types and dismisses. Nothing is
// submitted, so the spec writes NOTHING and can share the seeded session at any
// parallelism.

const TITLE_FIELD = "Reason / title";
const DRAFT = "e2e dialog convergence visit";

/** Where the scrim is: above a bottom-anchored sheet, clear of its panel. */
const SCRIM_POINT = { x: 195, y: 90 };

async function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => window.scrollY);
}

async function bodyOverflow(page: Page): Promise<string> {
  return page.evaluate(() => document.body.style.overflow);
}

/** Drag upward from low on the screen — the gesture that scrolls a page down. */
async function dragPageUp(page: Page, from = { x: 195, y: 640 }) {
  await touchSwipe(page, from, { x: from.x, y: from.y - 360 });
}

async function openAddVisit(page: Page) {
  await hydratedClick(page, page.getByTestId("add-visit-panel-toggle"));
  const dialog = page.getByRole("dialog", { name: "Add visit" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("the page behind an open record dialog does not move, and moves again once it closes", async ({
  page,
}) => {
  test.slow();
  await page.goto("/records/history/visits");
  await expect(page.getByTestId("visits-upcoming")).toBeVisible();

  // CONTROL, first: this page scrolls under exactly this gesture. Without it the
  // assertion below would pass just as well on a page that cannot scroll at all
  // — the classic green that proves nothing.
  await dragPageUp(page);
  const control = await scrollY(page);
  expect(control, "the page under test must be scrollable").toBeGreaterThan(0);

  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => scrollY(page)).toBe(0);

  const dialog = await openAddVisit(page);
  // The phone presentation is the sheet: bottom-anchored, with the drag handle
  // that makes a surface read as one (the owner decision in #2774).
  await expect(page.getByTestId("modal-shell")).toHaveAttribute(
    "data-presentation",
    "dialog"
  );
  await expect(dialog.getByTestId("sheet-drag-handle")).toBeVisible();

  // THE PIN. A drag the dialog does not consume — it starts on the scrim, which
  // scrolls nothing — used to chain straight out to the document.
  await touchSwipe(page, SCRIM_POINT, { x: SCRIM_POINT.x, y: 500 });
  await dragPageUp(page, { x: 195, y: 200 });
  expect(
    await scrollY(page),
    "the page must not move behind an open dialog"
  ).toBe(0);
  // And the mechanism is on: the surface holds the page still while it is open.
  expect(await bodyOverflow(page)).toBe("hidden");

  // The other half — the page is released, not permanently frozen.
  await hydratedClick(page, dialog.getByRole("button", { name: "Close" }));
  await expect(dialog).toHaveCount(0);
  expect(await bodyOverflow(page)).toBe("");
  await dragPageUp(page);
  expect(
    await scrollY(page),
    "the page must scroll again once the dialog has closed"
  ).toBeGreaterThan(0);
});

test("the page behind an open quick-entry sheet does not move either", async ({
  page,
}) => {
  test.slow();
  // The quick-entry overlay reached by url (#1424) — the OTHER half of #2774's
  // acceptance: one converged record form and one quick-entry form.
  await page.goto("/?quick=log-stool");
  await expect(page.getByTestId("quick-entry-sheet")).toBeVisible();
  expect(await scrollY(page)).toBe(0);

  await dragPageUp(page, { x: 195, y: 200 });
  expect(await scrollY(page)).toBe(0);
  expect(await bodyOverflow(page)).toBe("hidden");
});

test("a dirty converged form confirms before a gesture discards it; a clean one goes in one gesture", async ({
  page,
}) => {
  test.slow();
  await page.goto("/records/history/visits");
  await expect(page.getByTestId("visits-upcoming")).toBeVisible();

  const dialog = await openAddVisit(page);
  const title = dialog.getByLabel(TITLE_FIELD);
  await expect(title).toBeVisible();
  await title.fill(DRAFT);

  // A flick on the handle is the sheet's discard gesture (#1428). Right for a
  // half-typed weight; wrong for a form somebody has been filling in — so it
  // asks first (#2774, consequence B).
  await touchSwipeFrom(page, dialog.getByTestId("sheet-drag-handle"), {
    dy: 260,
  });
  const confirm = page.getByTestId("confirm-dialog");
  await expect(confirm).toBeVisible();

  // Keeping the edit leaves the form exactly as it was — the typing survives,
  // which is the whole point of asking.
  await hydratedClick(
    page,
    confirm.getByRole("button", { name: "Keep editing" })
  );
  await expect(confirm).toBeHidden();
  await expect(dialog).toBeVisible();
  await expect(title).toHaveValue(DRAFT);

  // The scrim is the other accidental dismissal, and it asks too.
  await page.touchscreen.tap(SCRIM_POINT.x, SCRIM_POINT.y);
  await expect(confirm).toBeVisible();
  await hydratedClick(page, confirm.getByRole("button", { name: "Discard" }));
  await expect(dialog).toHaveCount(0);

  // CLEAN: nothing typed, nothing to lose, so the same gesture dismisses without
  // a question. Without this half the guard could be a confirm on every
  // dismissal, which is the click-through it must not become.
  const reopened = await openAddVisit(page);
  await touchSwipeFrom(page, reopened.getByTestId("sheet-drag-handle"), {
    dy: 260,
  });
  await expect(reopened).toHaveCount(0);
  await expect(confirm).toHaveCount(0);
});

test("a dialog stacked over a sheet leaves the page held until the last one closes", async ({
  page,
}) => {
  test.slow();
  // The nesting invariant #2774 made mandatory before the body-scroll lock could
  // gain thirty-odd new holders. The count's ORDER-BLINDNESS is pinned at the
  // pure tier (lib/__tests__/scroll-lock.test.ts, both closing orders); this is
  // the real stack, in the browser, with two surfaces genuinely mounted at once.
  await page.goto("/records/history/visits");
  await expect(page.getByTestId("visits-upcoming")).toBeVisible();
  expect(await bodyOverflow(page)).toBe("");

  const dialog = await openAddVisit(page);
  await dialog.getByLabel(TITLE_FIELD).fill(DRAFT);
  expect(await bodyOverflow(page)).toBe("hidden");

  // The discard confirm opens a SECOND surface over the first.
  await page.touchscreen.tap(SCRIM_POINT.x, SCRIM_POINT.y);
  const confirm = page.getByTestId("confirm-dialog");
  await expect(confirm).toBeVisible();
  expect(await bodyOverflow(page)).toBe("hidden");

  // The INNER surface closes. The page must still be held — a save/restore lock
  // released it here, and the page underneath started moving with a dialog still
  // on screen.
  await hydratedClick(
    page,
    confirm.getByRole("button", { name: "Keep editing" })
  );
  await expect(confirm).toBeHidden();
  await expect(dialog).toBeVisible();
  expect(
    await bodyOverflow(page),
    "the outer dialog is still open, so the page is still held"
  ).toBe("hidden");

  // Only the LAST surface releases it.
  await hydratedClick(page, dialog.getByRole("button", { name: "Close" }));
  await expect(dialog).toHaveCount(0);
  expect(await bodyOverflow(page)).toBe("");
});
