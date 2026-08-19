import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
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

/** The dialog panel's top edge — where the sheet actually sits right now. */
async function panelTop(dialog: Locator): Promise<number> {
  const box = await dialog.boundingBox();
  expect(
    box,
    "the panel must be laid out to measure where it sits"
  ).not.toBeNull();
  return Math.round(box!.y);
}

// …once the panel has stopped moving. It SLIDES IN on open, so a reading taken
// the moment the dialog appears is a number it is still on its way past: this
// baseline read 180 and 194 on two runs whose true resting top was 172, and the
// comparison below then failed by the width of one animation frame. Asking the
// element whether it has any running animations left is exact — it covers the
// enter keyframe and the drag's settle transition alike, and under reduced
// motion there are none, so it returns at once.
async function restingPanelTop(dialog: Locator): Promise<number> {
  await expect
    .poll(() => dialog.evaluate((el) => el.getAnimations().length === 0), {
      message:
        "the panel must stop animating before its resting place can be measured",
    })
    .toBe(true);
  return panelTop(dialog);
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

test("the page behind an open record dialog does not move, and moves again once it closes", async ({
  page,
}) => {
  test.slow();
  await page.goto("/records/history/visits");
  await expect(page.getByTestId("visits-upcoming")).toBeVisible();

  // The dialog is opened from the TOP of the page, deliberately. A version of
  // this test scrolled first, and it was flaky for two reasons that are both
  // about the fixture rather than the fix: a touch drag FLINGS, so the page is
  // still decelerating when the next line reads it, and clicking a control that
  // scrolling has pushed near the viewport edge makes Playwright scroll it back
  // into view — a legitimate movement that the assertion cannot tell from the
  // defect. Neither happens from a standing start, and the defect is just as
  // visible: what is being pinned is that a drag under an open dialog moves the
  // page AT ALL.
  const dialog = await openAddVisit(page);
  // The phone presentation is the sheet: bottom-anchored, with the drag handle
  // that makes a surface read as one (the owner decision in #2774).
  await expect(page.getByTestId("modal-shell")).toHaveAttribute(
    "data-presentation",
    "dialog"
  );
  await expect(dialog.getByTestId("sheet-drag-handle")).toBeVisible();
  const held = await pageOffset(page);

  // THE PIN. A drag the dialog does not consume — one that starts on the scrim,
  // which scrolls nothing — used to chain straight out to the document, and the
  // page ended up somewhere other than where it was opened from.
  await dragPageUp(page);
  expect(
    await pageOffset(page),
    "the page must not move behind an open dialog"
  ).toBe(held);
  await dragScrimDown(page);
  expect(await pageOffset(page)).toBe(held);
  // And the mechanism is on: the surface holds the page still while it is open.
  expect(await bodyOverflow(page)).toBe("hidden");

  // The other half — the page is released where it was, not left frozen.
  await hydratedClick(page, dialog.getByRole("button", { name: "Close" }));
  await expect(dialog).toHaveCount(0);
  expect(await bodyOverflow(page)).toBe("");
  expect(
    await pageOffset(page),
    "closing must leave the reader where they were"
  ).toBe(held);

  // CONTROL, last: the very same gesture DOES scroll this page. Without it every
  // "it did not move" above would be satisfied by a page that cannot move at all
  // — the classic green that proves nothing.
  await dragPageUp(page);
  expect(
    await pageOffset(page),
    "the page must scroll again once the dialog has closed"
  ).toBeLessThan(held);
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
  expect(before, "a held page cannot be scrolled away from its parked 0").toBe(
    0
  );
});

// The dirty-discard guard (#2774, consequence B), in three tests rather than one
// chain. The chained version — flick, refuse, then tap the scrim, then reopen —
// was green here ten times over and red on CI, and a test whose failure cannot be
// reproduced is a test nobody can act on. Each guarantee now starts from a dialog
// in a known state, which is also the only way to tell WHICH of them broke.

test("a flick on a dirty form asks first, and keeping the edit brings the whole form back", async ({
  page,
}) => {
  test.slow();
  await page.goto("/records/history/visits");
  await expect(page.getByTestId("visits-upcoming")).toBeVisible();

  const dialog = await openAddVisit(page);
  const title = dialog.getByLabel(TITLE_FIELD);
  await expect(title).toBeVisible();
  await title.fill(DRAFT);
  // Measured after the typing as well as after the animation: what has to come
  // back is the panel as it stands when the flick starts.
  const atRest = await restingPanelTop(dialog);

  // A flick on the handle is the sheet's discard gesture (#1428). Right for a
  // half-typed weight; wrong for a form somebody has been filling in.
  await touchSwipeFrom(page, dialog.getByTestId("sheet-drag-handle"), {
    dy: 260,
  });
  const confirm = page.getByTestId("confirm-dialog");
  await expect(confirm).toBeVisible();

  // KEEPING THE EDIT PUTS THE FORM BACK — all of it, not just the text. The
  // flick has already dragged the panel most of the way off the bottom edge by
  // the time the question is asked, so a refused dismissal has to bring it home;
  // the first version of this feature did not, and left the dialog parked at
  // translateY(672px) with the typing safe inside a surface nobody could see.
  // Asserted as GEOMETRY because the obvious assertion does not catch that:
  // `toBeVisible()` passes on a panel with 0.06px left on screen.
  await hydratedClick(
    page,
    confirm.getByRole("button", { name: "Keep editing" })
  );
  await expect(confirm).toBeHidden();
  await expect
    .poll(() => panelTop(dialog), {
      message:
        "keeping the edit must settle the form back to rest, not leave it parked off the bottom edge",
    })
    .toBe(atRest);
  await expect(title).toHaveValue(DRAFT);

  // And the guard is not spent: the SAME gesture asks again, and this time the
  // answer is discard. Refusing a dismissal must not disarm the surface.
  await touchSwipeFrom(page, dialog.getByTestId("sheet-drag-handle"), {
    dy: 260,
  });
  await expect(confirm).toBeVisible();
  await hydratedClick(page, confirm.getByRole("button", { name: "Discard" }));
  await expect(dialog).toHaveCount(0);
});

test("a scrim tap on a dirty form asks first too", async ({ page }) => {
  test.slow();
  // The other accidental dismissal. Its own test, from its own clean dialog: the
  // scrim is a full-viewport sibling of the panel, so this is the one gesture
  // whose landing spot depends on nothing that happened earlier.
  await page.goto("/records/history/visits");
  await expect(page.getByTestId("visits-upcoming")).toBeVisible();

  const dialog = await openAddVisit(page);
  const title = dialog.getByLabel(TITLE_FIELD);
  await expect(title).toBeVisible();
  await title.fill(DRAFT);

  await page.touchscreen.tap(195, 90);
  const confirm = page.getByTestId("confirm-dialog");
  await expect(confirm).toBeVisible();
  await hydratedClick(page, confirm.getByRole("button", { name: "Discard" }));
  await expect(dialog).toHaveCount(0);
});

test("a clean converged form dismisses in one gesture, with no question", async ({
  page,
}) => {
  test.slow();
  // Nothing typed, nothing to lose. Without this the guard could be a confirm on
  // EVERY dismissal, which is the click-through it must not become.
  await page.goto("/records/history/visits");
  await expect(page.getByTestId("visits-upcoming")).toBeVisible();

  const dialog = await openAddVisit(page);
  await expect(dialog.getByLabel(TITLE_FIELD)).toBeVisible();
  await touchSwipeFrom(page, dialog.getByTestId("sheet-drag-handle"), {
    dy: 260,
  });
  await expect(dialog).toHaveCount(0);
  await expect(page.getByTestId("confirm-dialog")).toHaveCount(0);
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
