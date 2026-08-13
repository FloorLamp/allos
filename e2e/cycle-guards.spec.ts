import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import { fillPeriodDate, openAddPeriodPanel } from "./cycle-helpers";
import { frozenNow } from "./worker-env";
import { E2E_LOGIN_CYCLE_STALE, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Cycle plausibility guards (issue #1682): a period left open past the plausible maximum
// stops claiming menstrual and prompts instead of being silently closed, and the dated
// form refuses future dates and overlaps by NAMING the conflict rather than storing
// something the domain can't mean.
//
// Fixture-OWNED per e2e hygiene (#868): runs as E2E_LOGIN_CYCLE_STALE in its OWN cookie
// context on a dedicated adult profile seeded with one completed period plus one started
// 18 days ago and never ended. The spec never closes that period — every assertion here is
// either read-only or a REFUSED write, so nothing it does changes the fixture and
// --repeat-each stays clean. (The complementary "no open period" fixture is
// CYCLE_PROFILE, driven by cycle.spec.ts; one profile cannot be in both states.)

// Dates relative to the run's frozen clock, so the fixture never ages out.
function shift(days: number): string {
  const d = new Date(frozenNow());
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

test.describe("cycle plausibility guards (#1682)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_CYCLE_STALE,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("a long-open period prompts for the end date and stops claiming menstrual", async () => {
    await page.goto("/medical/cycles");

    // The claim is withdrawn: 18 days into an unended period, the phase no longer
    // asserts a state the data doesn't support.
    await expect(page.getByTestId("cycle-current-phase")).not.toHaveText(
      "Menstrual"
    );

    // But the record is untouched and still OPEN — the surface asks rather than closing
    // it, and the one-tap end is right there.
    const prompt = page.getByTestId("cycle-stale-open");
    await expect(prompt).toBeVisible();
    await expect(prompt).toContainText(/Still bleeding\?/);
    await expect(page.getByTestId("period-ended-button")).toBeVisible();
    await expect(page.getByText(/Period open since/)).toBeVisible();

    // #2583: the prompt's second route names History's Edit, not "set its end date
    // below". "Below" meant the dated ADD form, which mints a NEW row and whose
    // overlap gate refuses one covering this very period — so the direction never
    // worked, and folding that form (#2583) is what made the miss visible.
    await expect(prompt).toContainText(
      "use “Edit” on its row in the history below"
    );
    await expect(prompt).not.toContainText("set its end date below");
  });

  test("the form refuses a future start date", async () => {
    await page.goto("/medical/cycles");
    // Folded since #2583 — open it, then drive it exactly as before.
    const form = await openAddPeriodPanel(page);
    const rows = page.getByTestId("cycle-history-row");
    const before = await rows.count();

    await fillPeriodDate(page, "start", shift(1));
    await settledClick(page, form.getByRole("button", { name: "Add period" }));

    await expect(form.getByRole("alert")).toContainText(
      /can't start in the future/,
      { timeout: 20_000 }
    );
    await expect(rows).toHaveCount(before); // refused, so nothing was stored
  });

  test("the form refuses an overlapping period and names the conflict", async () => {
    await page.goto("/medical/cycles");
    const form = await openAddPeriodPanel(page);
    const rows = page.getByTestId("cycle-history-row");
    const before = await rows.count();

    // Inside the seeded completed period (46 → 42 days ago).
    await fillPeriodDate(page, "start", shift(-45));
    await fillPeriodDate(page, "end", shift(-43));
    await settledClick(page, form.getByRole("button", { name: "Add period" }));

    const alert = form.getByRole("alert");
    await expect(alert).toContainText(/already recorded/, { timeout: 20_000 });
    await expect(alert).toContainText(shift(-46)); // the conflict is NAMED
    await expect(rows).toHaveCount(before);
  });
});
