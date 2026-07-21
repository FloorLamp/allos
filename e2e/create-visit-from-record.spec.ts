import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick, followLink } from "./helpers";
import { E2E_LOGIN_CREATEVISIT, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// "Create a visit from this record?" (#1099), driven end-to-end. Runs as
// E2E_LOGIN_CREATEVISIT in its OWN cookie context on a dedicated profile
// (seed-events.ts) carrying ONE optical Rx dated a day with NO encounter. The spec
// accepts the create prompt on the Vision record card, then asserts the derived
// "Eye exam" visit appears in Visits with the Rx in its "From this visit" section.
// IDEMPOTENT under --repeat-each: it accepts only when the prompt is still present
// (a second run over the already-created visit skips straight to the end-state).

test.describe("create a visit from a record (#1099)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_CREATEVISIT,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  test("the Rx card prompts to create a visit; accept surfaces it with the Rx linked", async () => {
    await page.goto("/records#vision");

    // The prompt shows for the Rx dated a day with no encounter. Accept if present
    // (first run); a later run finds the Rx already linked and the prompt gone.
    const prompt = page.getByTestId("create-visit-from-record");
    if (await prompt.isVisible().catch(() => false)) {
      await settledClick(page, page.getByTestId("create-visit-accept"));
    }

    // End-state: the derived "Eye exam" visit exists in Visits, and its detail lists
    // the Rx under "From this visit".
    await page.goto("/records#visits");
    await followLink(
      page,
      page.getByRole("link", { name: /Eye exam/ }).first(), // first-ok: dedicated CREATEVISIT fixture profile — the only Eye exam visit is the one this spec created
      /\/encounters\/\d+/
    );
    await expect(page.getByTestId("encounter-detail")).toBeVisible();
    await expect(page.getByTestId("visit-linked-rows")).toContainText(
      "Rx Slip (e2e)"
    );
  });
});
