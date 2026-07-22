import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import { E2E_LOGIN_ENDURANCE, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Endurance event plans on the Training overview (issue #839): create a race plan and the
// Event-plans bar renders the recomputed this-week trajectory (target vs actual volume +
// long session), driven by the fixture profile's seeded run history.
//
// Fixture-OWNED per e2e hygiene (#868): runs as E2E_LOGIN_ENDURANCE in its OWN cookie
// context on a dedicated adult profile (seeded with a few weeks of runs, NO plan row). The
// spec OWNS the endurance_plans lifecycle — clearPlans() deletes every plan card beforeAll
// AND afterAll (and again at the top of the test body, so --repeat-each is self-contained).
// Every interaction settles via settledClick (the awaited Server-Action POST) — no
// networkidle / waitForTimeout.

// A future event date (~16 weeks out) as YYYY-MM-DD, so the plan is comfortably feasible.
function futureEventDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 112);
  return d.toISOString().slice(0, 10);
}

// Delete every endurance plan card, asserting the count drops each time so a re-render
// never lets a detaching button get re-clicked (the #868 settled-interaction rule).
async function clearPlans(page: Page): Promise<void> {
  await page.goto("/training?tab=overview");
  await expect(page.getByTestId("endurance-plan-bar")).toBeVisible();
  const cards = page.getByTestId("endurance-plan-card");
  let n = await cards.count();
  while (n > 0) {
    await settledClick(
      page,
      page.getByRole("button", { name: /^Delete / }).first() // first-ok: deletes the endurance plan THIS spec created
    );
    await expect(cards).toHaveCount(n - 1);
    n--;
  }
}

test.describe("endurance event plans (#839)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_ENDURANCE,
      password: E2E_MEMBER_PASSWORD,
    });
    await clearPlans(page);
  });

  test.afterAll(async () => {
    await clearPlans(page);
    await page.close();
  });

  test("create a plan → overview card shows target vs actual", async () => {
    test.slow(); // local `next dev` compiles /training on first hit
    // Self-contained under --repeat-each: start from a clean slate.
    await clearPlans(page);

    const bar = page.getByTestId("endurance-plan-bar");
    await expect(bar).toBeVisible();
    await expect(page.getByTestId("endurance-plan-card")).toHaveCount(0);

    // Open the add form and fill a 10 km run plan.
    await page.getByTestId("endurance-add-toggle").click();
    const form = page.getByTestId("endurance-form");
    await expect(form).toBeVisible();
    await page.getByTestId("endurance-event-name").fill("E2E 10k");
    await page.getByTestId("endurance-event-date").fill(futureEventDate());
    await page.getByTestId("endurance-distance").fill("10");
    await settledClick(page, page.getByTestId("endurance-submit"));

    // The plan card renders with its title, the target-vs-actual line, and the honest
    // feasibility message.
    const card = page.getByTestId("endurance-plan-card");
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId("endurance-plan-title")).toHaveText(
      "E2E 10k"
    );
    await expect(card.getByTestId("endurance-plan-target")).toContainText(
      /target/i
    );
    await expect(card.getByTestId("endurance-plan-message")).toContainText(
      /week/i
    );

    // A second active run plan is refused (one active plan per discipline).
    await page.getByTestId("endurance-add-toggle").click();
    await page.getByTestId("endurance-event-date").fill(futureEventDate());
    await page.getByTestId("endurance-distance").fill("21.1");
    await settledClick(page, page.getByTestId("endurance-submit"));
    // Still exactly one card — the duplicate was rejected.
    await expect(page.getByTestId("endurance-plan-card")).toHaveCount(1);

    // #1019: the Upcoming event item formats its distance per the login's
    // distanceUnit pref — a miles login sees "6.21 mi", not a hardcoded km.
    // This login owns its own dedicated prefs; restore km before the test ends
    // so --repeat-each starts from the same state.
    try {
      await page.goto("/settings");
      const distanceSelect = page.getByTestId("distance-unit-select");
      await distanceSelect.selectOption("mi");
      await expect(page.getByLabel("Saved")).toBeVisible();
      await page.goto("/upcoming");
      const eventItem = page
        .locator('[data-testid^="upcoming-item-endurance-event:"]')
        .first(); // first-ok: the endurance-event upcoming item from the plan THIS spec created
      await expect(eventItem).toBeVisible();
      await expect(eventItem).toContainText("6.21 mi");
      await expect(eventItem).not.toContainText("10 km");
    } finally {
      await page.goto("/settings");
      await page.getByTestId("distance-unit-select").selectOption("km");
      await expect(page.getByLabel("Saved")).toBeVisible();
    }
  });
});
