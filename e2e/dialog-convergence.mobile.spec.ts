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

async function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => window.scrollY);
}

async function bodyOverflow(page: Page): Promise<string> {
  return page.evaluate(() => document.body.style.overflow);
}

// Every gesture below is anchored to the DOCUMENT, not to an element: that is
// what a page scroll IS, and the scrim a drag starts on is a full-viewport
// sibling of the panel. Inline literals, per the e2e hygiene guard — a measured
// point would be the wrong tool for a gesture that is not aimed at anything.

/** Drag upward from low on the screen — the gesture that scrolls a page DOWN. */
async function dragPageUp(page: Page) {
  await touchSwipe(page, { x: 195, y: 480 }, { x: 195, y: 320 });
}

// WHERE THE PAGE IS, measured on the page itself rather than on `window.scrollY`.
// A locked page is parked (`position: fixed` with a top offset), so its scroll
// offset reads 0 the whole time it is held — true, and useless: it says nothing
// about whether the reader's place moved. The distance from the viewport top to a
// landmark ON the page is the thing a person would notice, so that is what gets
// asserted.
async function pageOffset(page: Page): Promise<number> {
  const box = await page.getByTestId("visits-upcoming").boundingBox();
  expect(
    box,
    "the landmark must be laid out to measure the page's place"
  ).not.toBeNull();
  return box!.y;
}

/** Drag downward from high on the screen — with a sheet open, that is its scrim. */
async function dragScrimDown(page: Page) {
  await touchSwipe(page, { x: 195, y: 90 }, { x: 195, y: 420 });
}

async function openAddVisit(page: Page) {
  await hydratedClick(page, page.getByTestId("add-visit-panel-toggle"));
  const dialog = page.getByRole("dialog", { name: "Add visit" });
  await expect(dialog).toBeVisible();
  return dialog;
}

test("the page behind an open record dialog does not move, and is still where it was when it closes", async ({
  page,
}) => {
  test.slow();
  await page.goto("/records/history/visits");
  await expect(page.getByTestId("visits-upcoming")).toBeVisible();

  // CONTROL, first: this page scrolls under exactly this gesture. Without it
  // every "it did not move" below would be satisfied by a page that cannot move
  // at all — the classic green that proves nothing.
  const atTop = await pageOffset(page);
  await dragPageUp(page);
  const scrolled = await pageOffset(page);
  expect(scrolled, "the page under test must be scrollable").toBeLessThan(
    atTop
  );

  // The dialog is opened from a control that is ON SCREEN, so the click cannot
  // scroll the page into view on its way — which would move the page for a
  // legitimate reason and make the next assertion unreadable.
  const toggle = page.getByTestId("add-visit-panel-toggle");
  const trigger = await toggle.boundingBox();
  expect(trigger, "the trigger must be laid out").not.toBeNull();
  expect(trigger!.y).toBeGreaterThan(0);
  expect(trigger!.y + trigger!.height).toBeLessThan(844);

  const dialog = await openAddVisit(page);
  // The phone presentation is the sheet: bottom-anchored, with the drag handle
  // that makes a surface read as one (the owner decision in #2774).
  await expect(page.getByTestId("modal-shell")).toHaveAttribute(
    "data-presentation",
    "dialog"
  );
  await expect(dialog.getByTestId("sheet-drag-handle")).toBeVisible();

  // FIRST HALF: opening did not move the page. A lock that merely makes the
  // viewport unscrollable throws the reader to the very top here, which is the
  // same complaint #2774 filed about the chaining, arriving by the other road.
  expect(
    await pageOffset(page),
    "opening a dialog must not move the page behind it"
  ).toBe(scrolled);

  // SECOND HALF, and the defect this issue is named for: a drag the dialog does
  // not consume — it starts on the scrim, which scrolls nothing — used to chain
  // straight out to the document. Both directions, because the old scroller
  // could give either one away.
  await dragScrimDown(page);
  expect(
    await pageOffset(page),
    "the page must not move behind an open dialog"
  ).toBe(scrolled);
  await dragPageUp(page);
  expect(await pageOffset(page)).toBe(scrolled);
  // And the mechanism is on: the surface holds the page still while it is open.
  expect(await bodyOverflow(page)).toBe("hidden");

  // THIRD: the page is released where it was, not frozen and not rewound.
  await hydratedClick(page, dialog.getByRole("button", { name: "Close" }));
  await expect(dialog).toHaveCount(0);
  expect(await bodyOverflow(page)).toBe("");
  expect(
    await pageOffset(page),
    "closing must put the reader back exactly where they were"
  ).toBe(scrolled);
  await dragPageUp(page);
  expect(
    await pageOffset(page),
    "the page must scroll again once the dialog has closed"
  ).toBeLessThan(scrolled);
});

test("the page behind an open quick-entry sheet does not move either", async ({
  page,
}) => {
  test.slow();
  // The quick-entry overlay reached by url (#1424) — the OTHER half of #2774's
  // acceptance: one converged record form and one quick-entry form. This one was
  // already a sheet, so it is the regression half rather than the fix half.
  await page.goto("/?quick=log-stool");
  await expect(page.getByTestId("quick-entry-sheet")).toBeVisible();
  expect(await bodyOverflow(page)).toBe("hidden");

  const before = await scrollY(page);
  await dragScrimDown(page);
  await dragPageUp(page);
  expect(
    await scrollY(page),
    "the dashboard must not move under the sheet"
  ).toBe(before);
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
  await page.touchscreen.tap(195, 90);
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
  await page.touchscreen.tap(195, 90);
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
