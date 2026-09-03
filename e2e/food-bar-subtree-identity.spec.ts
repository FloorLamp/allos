import type { JSHandle, Page } from "@playwright/test";
import { test, expect } from "./fixtures";
import { awaitHydrated, hydratedClick, settledClick } from "./helpers";

// THE FOOD LOG BAR UPDATES; IT DOES NOT REPLACE ITSELF (#4815).
//
// `/nutrition`'s overflow fold is an uncontrolled `<details>` (components/Disclosure.tsx
// — no state, no `open` prop), so its open state lives ONLY in the DOM node. Replace the
// node and the fold silently snaps shut under the finger that just opened it, with
// nothing to restore it. A re-render that UPDATES costs nothing; a re-render that
// REMOUNTS is a user-visible defect, and the two are indistinguishable from the outside
// unless something holds the node across the update and asks.
//
// So this holds the fold — and the whole bar — across every update the surface actually
// performs, and reads back through the HELD node rather than re-querying. Re-querying
// would answer "is there a fold on the page", which is true either way; only a held node
// can answer "is it the SAME fold".
//
// THE DISCRIMINATOR IS `contentVisibility`, and it is the sharpest one available (#4339
// measured the table): `getComputedStyle(el, "::details-content").contentVisibility` is
// `""` for exactly ONE state, a DETACHED node. An attached fold reads `"hidden"` closed
// and `"visible"` open — never empty — including under `display:none`, under a
// `display:none` parent, and under `content-visibility: hidden`. Re-derived on this tree
// while writing this spec, so the empty string here means the node was replaced and
// cannot mean a styling regression.
//
// The updates below are the ones the bar owns, and each one is a named candidate from
// #4815: the meal-slot switch and the day move (which re-derive the frozen row order and
// fire the async `fetched` read), the sibling eating-time fold, and a serving tap whose
// Server Action revalidates the page behind it.

const MORE = '[data-testid="food-more-groups"]';
const BAR = '[data-testid="food-log-bar"]';

/** The fold and the bar, held as the nodes they are right now. */
async function holdSubtree(page: Page): Promise<JSHandle> {
  return page.evaluateHandle(
    ([more, bar]) => ({
      more: document.querySelector(more as string),
      bar: document.querySelector(bar as string),
    }),
    [MORE, BAR] as const
  );
}

interface Reading {
  foldIsTheSameNode: boolean;
  barIsTheSameNode: boolean;
  contentVisibility: string;
  open: boolean | null;
}

async function readThroughHeld(
  page: Page,
  held: JSHandle
): Promise<Reading> {
  return page.evaluate(
    ([handles, more, bar]) => {
      const h = handles as { more: Element | null; bar: Element | null };
      const fold = h.more as HTMLDetailsElement | null;
      return {
        foldIsTheSameNode: document.querySelector(more as string) === fold,
        barIsTheSameNode: document.querySelector(bar as string) === h.bar,
        contentVisibility: fold
          ? getComputedStyle(fold, "::details-content").contentVisibility
          : "",
        open: fold?.open ?? null,
      };
    },
    [held, MORE, BAR] as const
  );
}

async function expectStillTheSameFold(
  page: Page,
  held: JSHandle,
  what: string
): Promise<void> {
  const reading = await readThroughHeld(page, held);
  const story =
    `after ${what}: ${JSON.stringify(reading)} — ` +
    `contentVisibility "" means the fold this test was holding was DETACHED, so the ` +
    `food log bar REPLACED its subtree instead of updating it (#4815). An open fold ` +
    `reads "visible" and a closed one "hidden"; only a replaced node reads empty.`;
  expect(reading.contentVisibility, story).not.toBe("");
  expect(reading.foldIsTheSameNode, story).toBe(true);
  expect(reading.barIsTheSameNode, story).toBe(true);
  // And the user's own state came through the update, which is the whole reason the
  // identity matters: a replaced uncontrolled `<details>` comes back closed.
  expect(reading.open, story).toBe(true);
}

test("the food log bar updates its overflow fold instead of replacing it (#4815)", async ({
  page,
}) => {
  // 430px: the phone width #4815 and #4339 both measured at, where this fold opens
  // into a long list and a snap-shut is a full-screen jump.
  await page.setViewportSize({ width: 430, height: 900 });
  await page.goto("/nutrition");
  const more = page.locator(MORE);
  await awaitHydrated(more);

  await hydratedClick(page, page.getByTestId("food-more-groups-summary"));
  await expect(more).toHaveAttribute("open", "");
  const held = await holdSubtree(page);
  await expectStillTheSameFold(page, held, "opening the fold");

  // 1. THE MEAL SLOT. It re-derives the quick set and the overflow from this meal's
  //    frozen order — the initialiser #4815 names as "frozen per mount", so a remount
  //    is exactly what would re-freeze it.
  await page.getByTestId("food-slot-evening").click();
  await expect(page.getByTestId("food-slot-evening")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expectStillTheSameFold(page, held, "switching the meal slot");

  // 2. THE SIBLING FOLD. A controlled `<details>` two slots above this one in the same
  //    section; its state change re-renders the whole bar.
  await page.getByTestId("food-when-summary").click();
  await expect(page.getByTestId("food-eating-time")).toHaveAttribute("open", "");
  await expectStillTheSameFold(page, held, "toggling the eating-time fold");

  // 3. A SERVING TAP. A Server Action whose response revalidates `/nutrition`, so the
  //    server's re-ranked catalog arrives as new props for every row.
  const firstRow = page
    .locator('[data-testid="food-quick-rows"] li[data-testid^="food-group-"]')
    .first(); // first-ok: any quick row proves the revalidated render landed — order-agnostic
  const slug = (await firstRow.getAttribute("data-testid"))!.replace(
    "food-group-",
    ""
  );
  const count = page.getByTestId(`count-${slug}`);
  const before = Number((await count.innerText()).trim());
  await settledClick(page, page.getByTestId(`log-${slug}`));
  await expect(count).toHaveText(String(before + 1));
  await expectStillTheSameFold(page, held, "a serving tap and its revalidation");

  // 4. THE DAY. Moving off the seeded day is what arms the async `fetched` read
  //    (#4815's first named candidate): a Server Action reply that lands a second
  //    later and re-renders the bar with the finger already on the fold. The picker is
  //    `hidden sm:block`, so the viewport widens for this step only — a resize is a
  //    layout event, not a remount, which the assertion below is itself a check on.
  await page.setViewportSize({ width: 800, height: 900 });
  await hydratedClick(page, page.getByTestId("food-day-yesterday"));
  await expect(page.getByTestId("food-day-yesterday")).toHaveAttribute(
    "aria-pressed",
    "true"
  );
  await expectStillTheSameFold(page, held, "moving the day picker back a day");
});
