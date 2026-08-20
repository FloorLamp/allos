import { test, expect } from "./fixtures";
import type { Locator, Page } from "@playwright/test";
import { hydratedClick } from "./helpers";

// A COMBOBOX INSIDE A BOUNDED SURFACE (#3271), asked on a phone — the instance
// that nothing else retires.
//
// The listbox used to render in flow, absolutely positioned, so any ancestor
// carrying an `overflow` clipped it; `z-50` never helped, because z-index does
// not escape a clip box. #2774/#3255 made the DESKTOP dialog's container the
// scroller and left the panel clipping nothing, which retired the owner's
// screenshot. Below `md` a sheet is bounded at `max-h-[85dvh]` with its content
// scrolling — that is the sheet contract working as designed — so on a phone the
// clip is still there. This spec is about the phone.
//
// WHAT IT ASSERTS, and why not the obvious thing. A clipped row still exists,
// still reports a bounding box (getBoundingClientRect ignores an ancestor's clip
// entirely), and still answers `toBeVisible()` with a fraction of a pixel
// showing. So presence proves nothing here. Two questions do: is the PANEL
// wholly on screen, and can its last row be REACHED — hit-test the row's centre
// and see whether the browser hands back the row itself or whatever is painted
// over it.
//
// Fixture hygiene (#868): types and dismisses, submits nothing, so this spec
// writes nothing and shares the seeded session at any parallelism.

const OPTION = "combobox-option";

/** Can a person actually touch this row, or is something painted over it? */
async function reachable(page: Page, option: Locator): Promise<boolean> {
  const box = await option.boundingBox();
  expect(
    box,
    "the row must be laid out before it can be hit-tested"
  ).not.toBeNull();
  return page.evaluate(
    ([x, y]) => {
      const el = document.elementFromPoint(x, y);
      return el instanceof Element
        ? el.closest('[data-testid="combobox-option"]') != null
        : false;
    },
    [box!.x + box!.width / 2, box!.y + box!.height / 2] as const
  );
}

async function openAddSupplementName(page: Page): Promise<Locator> {
  await page.goto("/nutrition?tab=supplements");
  await hydratedClick(page, page.getByTestId("supplement-add-toggle"));
  const dialog = page.getByRole("dialog", { name: "Add supplement" });
  await expect(dialog).toBeVisible();
  const name = dialog.getByRole("combobox", { name: "Name" });
  await name.click();
  await expect(name).toHaveAttribute("aria-expanded", "true");
  return name;
}

test("a picker in a phone sheet is contained, and its last row reachable (#3271)", async ({
  page,
}) => {
  await openAddSupplementName(page);

  const listbox = page.getByRole("listbox");
  const options = page.getByTestId(OPTION);
  const count = await options.count();
  expect(
    count,
    "the empty-query list must offer rows to contain"
  ).toBeGreaterThan(1);

  const viewport = page.viewportSize();
  expect(viewport).not.toBeNull();

  // CONTAINMENT, asked of the panel itself. This is the claim the bug could not
  // have satisfied: in flow the list ran straight past the sheet's bottom edge —
  // and past the screen's — because the sheet sizes to its content and sits on
  // the bottom of the phone, so the field it drops from is already near there.
  // Escaping an ancestor's clip is only half the job; the panel has to stay on
  // screen too, which is why both edges are asked about.
  const box = await listbox.boundingBox();
  expect(box, "the listbox must be laid out to be measured").not.toBeNull();
  expect(
    box!.y,
    "the list starts above the top of the screen"
  ).toBeGreaterThanOrEqual(0);
  expect(
    box!.y + box!.height,
    "the list runs off the bottom of the screen"
  ).toBeLessThanOrEqual(viewport!.height);

  // REACHABILITY. A clipped row still exists, still reports a bounding box, and
  // still answers toBeVisible() with a fraction of a pixel showing — so the
  // question is whether the browser hands the row back when its own centre is
  // touched. The list scrolls itself once it is taller than the room it was
  // given, which is the design; the claim is that scrolling it GETS you there.
  expect(
    await reachable(page, options.first()), // first-ok: the list's LEADING row is the assertion — it is the one the clip spared, so it is the control for the last
    "the first row"
  ).toBe(true);
  const last = options.nth(count - 1);
  await last.scrollIntoViewIfNeeded();
  expect(await reachable(page, last), "the last row").toBe(true);
});

test("the keyboard reaches the last row of a portaled list (#3271)", async ({
  page,
}) => {
  const name = await openAddSupplementName(page);

  const options = page.getByTestId(OPTION);
  const count = await options.count();
  const last = (await options.nth(count - 1).innerText()).trim();

  // Arrow down to the final row and take it. The list living in a portal must
  // not change what the arrow keys address — they are handled on the input,
  // which never moved.
  for (let i = 1; i < count; i++) await name.press("ArrowDown");
  await name.press("Enter");

  await expect(name).toHaveValue(last);
  await expect(name).toHaveAttribute("aria-expanded", "false");
});
