import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick, followLink } from "./helpers";
import { E2E_LOGIN_VISITLINKS, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Record ↔ visit (#1050) and episode ↔ visit (#1053) linking, driven end-to-end.
// Runs as E2E_LOGIN_VISITLINKS in its OWN cookie context on a dedicated profile
// (seed-events.ts) carrying one visit, a same-day unlinked medication + prescription,
// and an illness episode spanning that day. Each test is written to be IDEMPOTENT
// under --repeat-each: it links only when the suggestion is still present, then
// asserts the LINKED end-state — so a second run over the already-linked DB passes.

test.describe("record ↔ visit / episode ↔ visit linking (#1050/#1053)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_VISITLINKS,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  async function openTheVisit() {
    await page.goto("/records#visits");
    await followLink(
      page,
      page.getByRole("link", { name: /Office Visit/ }).first(), // first-ok: dedicated VISITLINKS fixture profile — the only Office Visit rows are this spec's own
      /\/encounters\/\d+/
    );
    await expect(page.getByTestId("encounter-detail")).toBeVisible();
  }

  test("the visit's 'From this visit?' block links the med and renders it linked", async () => {
    await openTheVisit();

    // If the suggestion is still present (first run), accept the batch.
    const suggestions = page.getByTestId("from-this-visit-suggestions");
    if (await suggestions.isVisible().catch(() => false)) {
      await settledClick(page, page.getByTestId("link-all-from-visit"));
    }

    // Linked end-state: the "From this visit" section lists the medication.
    await expect(page.getByTestId("visit-linked-rows")).toContainText(
      "Amoxicillin (e2e)"
    );
  });

  test("the medication detail shows 'Prescribed at' the linked visit", async () => {
    // Ensure the link exists (idempotent — no-op if already linked in test 1).
    await openTheVisit();
    const suggestions = page.getByTestId("from-this-visit-suggestions");
    if (await suggestions.isVisible().catch(() => false)) {
      await settledClick(page, page.getByTestId("link-all-from-visit"));
    }

    await page.goto("/medications");
    await followLink(
      page,
      page.getByRole("link", { name: /Amoxicillin \(e2e\)/ }).first(), // first-ok: dedicated VISITLINKS fixture profile — Amoxicillin (e2e) exists only in this spec's seed
      /\/medications\/\d+/
    );
    await expect(page.getByTestId("medication-detail")).toBeVisible();
    await expect(page.getByTestId("medication-prescribed-at")).toContainText(
      "Prescribed at:"
    );
  });

  test("the episode cockpit Care line links the visit and the encounter back-links", async () => {
    await page.goto("/medical/episodes");
    await followLink(
      page,
      page.getByRole("link", { name: /sinus infection/i }).first(), // first-ok: dedicated VISITLINKS fixture profile — the sinus-infection episode is this spec's own fixture
      /\/medical\/episodes\/\d+/
    );
    const care = page.getByTestId("episode-care");
    await expect(care).toBeVisible();

    // Link the in-range visit if still suggested (first run).
    const linkBtn = care.getByRole("button", { name: "Link this visit" });
    if (await linkBtn.isVisible().catch(() => false)) {
      await settledClick(page, linkBtn);
    }

    // Linked end-state: the Care line resolves to the visit.
    await expect(page.getByTestId("episode-care-link")).toBeVisible();

    // And the visit shows the "During illness episode … day N" back-link.
    await followLink(
      page,
      page.getByTestId("episode-care-link"),
      /\/encounters\/\d+/
    );
    await expect(page.getByTestId("encounter-episode-backlink")).toContainText(
      "During illness episode: sinus infection"
    );
  });
});
