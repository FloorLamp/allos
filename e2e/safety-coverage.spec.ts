import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_COVERAGE, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import {
  intakeWarnings,
  safetyScopeFooter,
  safetyScopeSummary,
  safetyScopeLine,
} from "./intake-warnings-helpers";

// Safety-check coverage legibility (issue #1032). The dedicated fixture profile
// tracks two name-only meds that yield NO warnings (loratadine — off the curated
// interaction set; sertraline — matched but partnerless), so pre-#1032 both safety
// strips rendered exactly nothing — indistinguishable from "never checked". Now the
// empty state renders a quiet scope disclosure (not the active-warning card) on
// BOTH intake surfaces without repeating a limited-screening chip on every row.
// Read-only on an isolated fixture login (#868) — repeat-safe by construction.

test("the Medications page keeps empty screening context in the footer", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_COVERAGE,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/medications");
  const main = page.getByRole("main");

  await expect(intakeWarnings(main)).toHaveCount(0);
  const footer = safetyScopeFooter(main);
  await expect(footer).toBeVisible();
  expect(
    await footer.evaluate((node) => {
      const medicationList = document.querySelector(
        '[data-testid="medication-list"]'
      );
      return Boolean(
        medicationList &&
        medicationList.compareDocumentPosition(node) &
          Node.DOCUMENT_POSITION_FOLLOWING
      );
    })
  ).toBe(true);
  const summary = safetyScopeSummary(main);
  await expect(summary).toHaveText("Curated safety screen · no flags found");
  await summary.click();

  const scope = safetyScopeLine(main);
  await expect(scope).toBeVisible();
  await expect(scope).toContainText("curated set");
  await expect(scope).toContainText("1 of 2 active items");
  await expect(scope).toContainText("No flags found");
  await expect(scope).toContainText("not an exhaustive one");
  // Degraded-coverage honesty: both meds are name-only.
  await expect(scope).toContainText("no confirmed RxNorm code");

  await expect(main.getByTestId("coverage-limited-chip")).toHaveCount(0);

  await page.context().close();
});

test("the Supplements tab renders the same scope line (one computation, both surfaces)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_COVERAGE,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/nutrition?tab=supplements");
  const main = page.getByRole("main");

  await expect(intakeWarnings(main)).toHaveCount(0);
  const footer = safetyScopeFooter(main);
  await expect(footer).toBeVisible();
  expect(
    await footer.evaluate((node) => {
      const addCard = document.querySelector(
        '[data-testid="add-supplement-card"]'
      );
      return Boolean(
        addCard &&
        addCard.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING
      );
    })
  ).toBe(true);
  const summary = safetyScopeSummary(main);
  await expect(summary).toHaveText("Curated safety screen · no flags found");
  await summary.click();

  const scope = safetyScopeLine(main);
  await expect(scope).toBeVisible();
  await expect(scope).toContainText("1 of 2 active items");
  await expect(scope).toContainText("No flags found");

  await page.context().close();
});
