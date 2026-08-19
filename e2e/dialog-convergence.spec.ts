import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { hydratedClick } from "./helpers";

// The desktop half of the #2774 convergence — the sibling of
// e2e/dialog-convergence.mobile.spec.ts. Above `md` the one primitive renders a
// centred card, and the two facts that used to be per-host accidents are now
// properties of the primitive:
//
//   * it OWNS THE VIEWPORT — a wheel over the page behind it moves nothing,
//     where ModalShell's `fixed inset-0 overflow-y-auto` scroller over an
//     unlocked body let the wheel chain out to the document;
//   * its WIDTH IS DECLARED — `size` replaces the thirty `max-w-*` className
//     overrides the call sites used to carry.
//
// Fixture hygiene (#868): both tests open a dialog and close it. Nothing is
// submitted, so this spec writes nothing.

async function scrollY(page: Page): Promise<number> {
  return page.evaluate(() => window.scrollY);
}

/** Wheel over the scrim — clear of the centred panel, which owns its own scroll. */
async function wheelOverScrim(page: Page) {
  await page.mouse.move(60, 450);
  await page.mouse.wheel(0, 600);
}

async function panelWidth(page: Page, name: string): Promise<number> {
  const box = await page
    .getByRole("dialog", { name })
    .boundingBox({ timeout: 5_000 });
  expect(box, `${name} must be on screen to measure`).not.toBeNull();
  return box!.width;
}

test("a wheel over the page behind an open dialog moves nothing until it closes", async ({
  page,
}) => {
  test.slow();
  await page.goto("/longevity#protocols");
  const main = page.getByRole("main");

  // CONTROL: this page scrolls under exactly this wheel. The assertion below is
  // worthless without it — "nothing moved" is trivially true of a short page.
  await page.evaluate(() => window.scrollTo(0, 0));
  await wheelOverScrim(page);
  await expect.poll(() => scrollY(page)).toBeGreaterThan(0);
  await page.evaluate(() => window.scrollTo(0, 0));
  await expect.poll(() => scrollY(page)).toBe(0);

  await hydratedClick(page, main.getByTestId("new-protocol-toggle"));
  const dialog = page.getByRole("dialog", { name: "New protocol" });
  await expect(dialog).toBeVisible();

  await wheelOverScrim(page);
  expect(
    await scrollY(page),
    "the page must not scroll behind an open dialog"
  ).toBe(0);

  await hydratedClick(page, dialog.getByRole("button", { name: "Close" }));
  await expect(dialog).toHaveCount(0);
  await wheelOverScrim(page);
  await expect
    .poll(() => scrollY(page), {
      message: "the page must scroll again once the dialog has closed",
    })
    .toBeGreaterThan(0);
});

test("a dialog's declared size decides how wide it renders", async ({
  page,
}) => {
  test.slow();
  // Two consumers that declare DIFFERENT sizes, measured at the same viewport.
  // The assertion is on the rendered geometry, not on a class string: a
  // `toContain("max-w-4xl")` would pass just as well if the class never reached
  // an element, which is the failure mode the size prop exists to end.
  await page.goto("/wellness");
  await hydratedClick(page, page.getByTestId("practice-create-trigger"));
  await expect(
    page.getByRole("dialog", { name: "Add a practice" })
  ).toBeVisible();
  const small = await panelWidth(page, "Add a practice");

  await page.goto("/longevity#protocols");
  await hydratedClick(
    page,
    page.getByRole("main").getByTestId("new-protocol-toggle")
  );
  await expect(
    page.getByRole("dialog", { name: "New protocol" })
  ).toBeVisible();
  const large = await panelWidth(page, "New protocol");

  expect(
    large,
    "a dialog declared `lg` must render wider than one declared `sm`"
  ).toBeGreaterThan(small);
  // …and neither is the full viewport: a centred card is still a card.
  expect(large).toBeLessThan(1280);
});
