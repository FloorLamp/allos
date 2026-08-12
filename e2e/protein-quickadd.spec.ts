import { test, expect } from "./fixtures";
import type { Locator } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import { E2E_LOGIN_PROTEIN, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Protein-grams quick-add in the Nutrition Food logging list (issue #824). Protein
// powder / shakes have no serving-based food-group catalog home, so this row is the
// direct grams path that SUMS with the food-group estimated floor.
//
// Fixture-OWNED per e2e hygiene (#868): runs as E2E_LOGIN_PROTEIN in its OWN cookie
// context on a dedicated profile (seeded with a bodyweight + poultry/eggs today → the
// card starts on the ESTIMATED basis, no protein_log rows). The spec drives the grams
// add + undo on that isolated profile, so logging never races the shared protein-adequacy
// spec. Add→undo leaves the fixture as found; every interaction settles via settledClick.

// How many ranked food-group rows sit ABOVE the protein control in the quick-log
// section — the observable of "the protein entry is ranked, not pinned" (#1980).
async function rowsAbove(quickLog: Locator): Promise<number> {
  const proteinBox = await quickLog
    .getByTestId("protein-quickadd")
    .boundingBox();
  expect(proteinBox).not.toBeNull();
  const boxes = await Promise.all(
    (await quickLog.locator('li[data-testid^="food-group-"]').all()).map(
      (row) => row.boundingBox()
    )
  );
  return boxes.filter((b) => b !== null && b.y < proteinBox!.y).length;
}

test("logging protein grams sums into the adequacy floor, undo removes it (#824)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_PROTEIN,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    // Local `next dev` compiles the nutrition route on first hit.
    test.slow();
    await page.goto("/nutrition");

    // The adequacy card starts on the ESTIMATED basis (food groups only, no grams yet).
    const card = page.getByTestId("protein-adequacy");
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("data-basis", "estimated");

    // The quick-add is a peer of regular food rows, not part of nutrient analysis.
    const quickLog = page.getByTestId("food-quick-log");
    const quickadd = quickLog.getByTestId("protein-quickadd");
    await expect(quickadd).toBeVisible();
    await expect(
      page.getByTestId("nutrients-card").getByTestId("protein-quickadd")
    ).toHaveCount(0);
    const total = page.getByTestId("protein-quickadd-total");
    await expect(total).toHaveText(/0g today/);

    // Enter 30 g and add — the running total ticks up and the card flips to COMBINED,
    // naming the composition (estimated foods + logged grams).
    await page.getByTestId("protein-quickadd-input").fill("30");
    await settledClick(page, page.getByTestId("protein-quickadd-add"));
    await expect(total).toHaveText(/30g today/);
    await expect(card).toHaveAttribute("data-basis", "combined");
    await expect(page.getByTestId("protein-intake")).toContainText(
      /30 g logged/
    );

    // RANKED, not pinned (#1980). The profile tracks protein now, so the reserved protein
    // entry joins the ONE food-group ranking and the control renders at the position its
    // own ledger signal earned — with ranked rows BELOW it, where it used to be pinned
    // after (untracked) or before (tracked) the whole list by layout alone. (The row order
    // is frozen per mount, so this is read after a reload rather than expecting the live
    // list to re-sort under the finger that just tapped. The untracked half of the rule —
    // no control at all on the compact quick-log sheet — is pinned by
    // quick-log-overlay.mobile.spec.ts, whose fixture profile never logs protein; this one
    // cannot assert it, because an add records the scoop-size preset for good.)
    await page.reload();
    await expect(quickadd).toBeVisible();
    const rows = await quickLog
      .locator('li[data-testid^="food-group-"]')
      .count();
    expect(await rowsAbove(quickLog)).toBeLessThan(rows);

    // The grams reach the one long-range nutrition chart too (#2414). This profile has
    // NO tracked protein_g, so Trends → Nutrition → Macros & fiber used to render its
    // empty state at a profile that logs protein — the chart was blind to the app's own
    // logging. With today's grams logged it draws the series instead.
    await page.goto("/trends?tab=nutrition");
    const macros = page.getByTestId("nutrition-macros-chart");
    await expect(macros).toBeVisible();
    await expect(page.getByTestId("nutrition-macros-empty")).toHaveCount(0);
    await expect(macros.getByText("Protein", { exact: true })).toBeVisible();

    // …and now that it HAS content it leads the sections that do not (#2399). This
    // profile confirms no doses, so the dose history is a setup prompt — which used
    // to sit above the chart by declared order alone, making the reader scroll past
    // a feature they have not set up to reach one that works.
    const sections = await page
      .locator(
        '[data-testid="intake-history"], [data-testid="dose-history"], [data-testid="nutrition-macros-chart"], [data-testid="food-adherence-trend"]'
      )
      .evaluateAll((els) => els.map((e) => e.getAttribute("data-testid")));
    expect(sections).toEqual([
      "intake-history",
      "nutrition-macros-chart",
      "dose-history",
      "food-adherence-trend",
    ]);

    // A sunk section still OFFERS: the empty state keeps a one-line prompt naming
    // where to act, rather than a card-shaped placeholder holding a plot's height.
    const doses = page.getByTestId("dose-history");
    await expect(
      doses.getByRole("link", { name: /Supplements/ })
    ).toBeVisible();

    await page.goto("/nutrition");
    await expect(total).toHaveText(/30g today/);

    // Undo removes the grams from the same day's total → back to the estimated basis.
    await settledClick(page, page.getByTestId("protein-quickadd-undo"));
    await expect(total).toHaveText(/0g today/);
    await expect(card).toHaveAttribute("data-basis", "estimated");
  } finally {
    await page.context().close();
  }
});
