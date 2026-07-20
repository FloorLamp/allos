import { test, expect } from "@playwright/test";
import { loginAs } from "./nav";
import { E2E_LOGIN_COVERAGE, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Safety-check coverage legibility (issue #1032). The dedicated fixture profile
// tracks two name-only meds that yield NO warnings (loratadine — off the curated
// interaction set; sertraline — matched but partnerless), so pre-#1032 both safety
// strips rendered exactly nothing — indistinguishable from "never checked". Now the
// empty state renders a calm scope line ("checked 1 of 2, no flags — a curated
// check, not an exhaustive one") on BOTH intake surfaces, and each name-only med
// row wears the quiet limited-screening chip pointing at the RxNorm confirm flow.
// Read-only on an isolated fixture login (#868) — repeat-safe by construction.

test("the Medications safety strip renders the honest empty state + limited-screening chips", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_COVERAGE,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/medications");
  const main = page.getByRole("main");

  const scope = main.getByTestId("safety-scope-line");
  await expect(scope).toBeVisible();
  await expect(scope).toContainText("curated set");
  await expect(scope).toContainText("1 of 2 active items");
  await expect(scope).toContainText("No flags found");
  await expect(scope).toContainText("not an exhaustive one");
  // Degraded-coverage honesty: both meds are name-only.
  await expect(scope).toContainText("no confirmed RxNorm code");

  // The per-item chip renders quietly on the name-only rows (both are current).
  await expect(main.getByTestId("coverage-limited-chip")).toHaveCount(2);

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

  const scope = main.getByTestId("safety-scope-line");
  await expect(scope).toBeVisible();
  await expect(scope).toContainText("1 of 2 active items");
  await expect(scope).toContainText("No flags found");

  await page.context().close();
});
