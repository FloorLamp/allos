import { test, expect } from "./fixtures";
import type { Page } from "@playwright/test";
import { followLink } from "./helpers";

// One back affordance per detail page (#3237).
//
// Detail pages had drifted into four grammars — above the title, below it,
// inside a card, and (on dose history) absent, with a right-aligned FORWARD link
// standing in for one — and there was no house component to converge on. This
// spec pins the two halves a shared `BackLink` is FOR, on surfaces that reach
// their detail page by different routes:
//
//   • the affordance EXISTS, and
//   • it sits ABOVE the page's h1 in document order.
//
// The placement half is asserted through `compareDocumentPosition` rather than a
// class or a bounding box, because the defect was ordering: /training/activity
// put its way out below the title, which wedges navigation chrome between an h1
// and the content it heads. A screenshot-free structural check is the thing that
// stays true when the styling is next revised.

async function expectBackLinkAboveTitle(
  page: Page,
  name: string | RegExp
): Promise<void> {
  const back = page.getByRole("link", { name });
  await expect(back).toBeVisible();
  const h1 = page.getByRole("heading", { level: 1 });
  await expect(h1).toHaveCount(1);
  // DOCUMENT_POSITION_FOLLOWING (4) means the h1 comes AFTER the back link.
  const titleFollows = await back.evaluate((link: Element) => {
    const heading = document.querySelector("h1");
    if (!heading) return false;
    return Boolean(link.compareDocumentPosition(heading) & 4);
  });
  expect(titleFollows).toBe(true);
}

test("a settings group's way out is the shared back link, above its title", async ({
  page,
}) => {
  await page.goto("/settings/health");
  // Same marker the settings IA specs navigate by — the shape changed, the
  // handle did not.
  await expect(page.getByTestId("settings-breadcrumb")).toBeVisible();
  await expectBackLinkAboveTitle(page, "All settings");
});

test("dose history has a way BACK, not just a way onward", async ({ page }) => {
  await page.goto("/nutrition/dose-history");
  await expectBackLinkAboveTitle(page, "Back to supplements");
  // The header's old "Supplements →" pointed at the very destination the back
  // link now names, so the page offered the same door twice and neither was a
  // back. One link to the supplements surface, and it reads as a return.
  await expect(
    page
      .getByTestId("dose-ledger-page")
      .getByRole("link", { name: /Supplements/ })
  ).toHaveCount(1);
});

test("an episode detail page has a way back to the care trail", async ({
  page,
}) => {
  await page.goto("/medical/episodes");
  const row = page.getByTestId("episode-index-row").first(); // first-ok: any seeded episode proves the shell; no per-row claim is made
  await followLink(page, row, /\/medical\/episodes\/\d+/);
  await expectBackLinkAboveTitle(page, "Back to episodes");
});

test("your own medication detail shows a back link and no identity banner", async ({
  page,
}) => {
  await page.goto("/medications");
  const rowLink = page.getByTestId("medication-row-link").first(); // first-ok: the banner/back-link choice is per-page, identical for every seeded row
  const href = await rowLink.getAttribute("href");
  expect(href).toMatch(/\/medications\/\d+/);
  await page.goto(href!);

  await expect(page.getByTestId("medication-detail")).toBeVisible();
  await expectBackLinkAboveTitle(page, "Back to medications");
  // ProfileIdentityBanner answers "whose medication is this?", which is not a
  // question on your own. Unconditional, it drew an avatar + your own name above
  // your own back link — this page was its only call site in the app. The
  // cross-profile case still renders it, and e2e/shared-supply-pool.spec.ts
  // drives that half through `medication-subject-name`.
  await expect(page.getByTestId("medication-identity-banner")).toHaveCount(0);
});
