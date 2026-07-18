import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import { E2E_LOGIN_PROTEIN, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Protein-grams quick-add on the Nutrition Food tab (issue #824). Protein powder /
// shakes have no food-group catalog home, so this control is the shake path: a direct
// grams entry that SUMS with the food-group estimated floor on the adequacy card.
//
// Fixture-OWNED per e2e hygiene (#868): runs as E2E_LOGIN_PROTEIN in its OWN cookie
// context on a dedicated profile (seeded with a bodyweight + poultry/eggs today → the
// card starts on the ESTIMATED basis, no protein_log rows). The spec drives the grams
// add + undo on that isolated profile, so logging never races the shared protein-adequacy
// spec. Add→undo leaves the fixture as found; every interaction settles via settledClick.

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

    // The quick-add control is present with a zero running total.
    const quickadd = page.getByTestId("protein-quickadd");
    await expect(quickadd).toBeVisible();
    const total = page.getByTestId("protein-quickadd-total");
    await expect(total).toHaveText(/0 g today/);

    // Enter 30 g and add — the running total ticks up and the card flips to COMBINED,
    // naming the composition (estimated foods + logged grams).
    await page.getByTestId("protein-quickadd-input").fill("30");
    await settledClick(page, page.getByTestId("protein-quickadd-add"));
    await expect(total).toHaveText(/30 g today/);
    await expect(card).toHaveAttribute("data-basis", "combined");
    await expect(page.getByTestId("protein-intake")).toContainText(
      /30 g logged/
    );

    // The last-used preset chip now offers the 30 g scoop for next time.
    await expect(page.getByTestId("protein-quickadd-preset")).toContainText(
      "30 g"
    );

    // Undo removes the grams from the same day's total → back to the estimated basis.
    await settledClick(page, page.getByTestId("protein-quickadd-undo"));
    await expect(total).toHaveText(/0 g today/);
    await expect(card).toHaveAttribute("data-basis", "estimated");
  } finally {
    await page.context().close();
  }
});
