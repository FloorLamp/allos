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
// spec OWNS the endurance_plans lifecycle — a create-and-clean block deletes any leftover
// plan cards beforeAll AND afterAll, so a retry or a neighbor never leaves it dirty. Every
// interaction settles via settledClick (the awaited Server-Action POST) — no networkidle /
// waitForTimeout.

// A future event date (~16 weeks out) as YYYY-MM-DD, so the plan is comfortably feasible.
function futureEventDate(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() + 112);
  return d.toISOString().slice(0, 10);
}

// Delete every endurance plan card currently rendered (the profile's active plans).
async function clearPlans(page: Page): Promise<void> {
  await page.goto("/training");
  await expect(page.getByTestId("endurance-plan-bar")).toBeVisible();
  const dels = page.getByRole("button", { name: /^Delete / });
  for (let i = 0; i < 6 && (await dels.count()) > 0; i++) {
    await settledClick(page, dels.first());
  }
  await expect(page.getByTestId("endurance-plan-card")).toHaveCount(0);
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
    await page.goto("/training");

    const bar = page.getByTestId("endurance-plan-bar");
    await expect(bar).toBeVisible();
    // Empty state before any plan.
    await expect(page.getByTestId("endurance-plan-card")).toHaveCount(0);

    // Open the add form and fill a 10 km run plan.
    await page.getByTestId("endurance-add-toggle").click();
    const form = page.getByTestId("endurance-form");
    await expect(form).toBeVisible();
    await page.getByTestId("endurance-event-name").fill("E2E 10k");
    await page.getByTestId("endurance-event-date").fill(futureEventDate());
    await page.getByTestId("endurance-distance").fill("10");
    await settledClick(page, page.getByTestId("endurance-submit"));

    // The plan card renders with its title and the target-vs-actual line.
    const card = page.getByTestId("endurance-plan-card");
    await expect(card).toHaveCount(1);
    await expect(card.getByTestId("endurance-plan-title")).toHaveText(
      "E2E 10k"
    );
    const target = card.getByTestId("endurance-plan-target");
    await expect(target).toContainText(/target/i);
    // The honest feasibility message renders.
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
  });
});
