import { test, expect } from "./fixtures";
import { type Page } from "@playwright/test";
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
    await page.goto("/records/history/visits");
    await followLink(
      page,
      page.getByRole("link", { name: /Office Visit/ }).first(), // first-ok: exactly one link ON THIS PAGE matches — the dedicated VISITLINKS profile owns a single Office Visit — and the destination (the encounter detail) names its type only in a heading, never in a link
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
      page.getByRole("link", { name: /Amoxicillin \(e2e\)/ }).first(), // first-ok: exactly one link ON THIS PAGE matches — the dedicated VISITLINKS profile seeds a single Amoxicillin (e2e) — and the destination (the medication detail) names it only in its heading, never in a link
      /\/medications\/\d+/
    );
    await expect(page.getByTestId("medication-detail")).toBeVisible();
    await expect(page.getByTestId("medication-prescribed-at")).toContainText(
      "Prescribed at:"
    );
  });

  test("the episode cockpit Care line links the visit and the encounter back-links", async () => {
    await page.goto("/medical/episodes");
    // Pinned to the INDEX row, not to the name (#2631). followLink re-evaluates its
    // locator on every retry, so a locator that is only a name is evaluated against
    // whatever page is loaded at that moment — and the destination cockpit carries a
    // link matching /sinus infection/i too: the timeline's encounter care event uses
    // the encounter's `reason` ("Sinus infection") as its link text and points at
    // /encounters/<id>. Under contention the first click's transition had not
    // committed when the retry fired, the retry resolved on the cockpit, and the test
    // landed on /encounters/9077. `episode-index-row` exists ONLY on this index, so
    // the locator can no longer resolve anywhere else.
    await followLink(
      page,
      page
        .getByTestId("episode-index-row")
        .filter({ hasText: /sinus infection/i })
        .first(), // first-ok: exactly one episode row ON THIS PAGE carries that text — the axis that makes a .first() safe is "one match on the page being clicked", not "one match in the fixture profile"
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

    // #1198 many-model surface: the linked visit renders in the "Visits during this
    // episode" list with its own Unlink control (the episode holds a SET of visits now).
    const visitList = page.getByTestId("episode-care-visits");
    await expect(visitList).toBeVisible();
    await expect(visitList).toContainText(/Visit during this episode/i);
    await expect(
      visitList.getByRole("button", { name: "Unlink" })
    ).toBeVisible();

    // And the visit's episode care trail (#1350) shows this episode with the shared
    // status line, linking back into the episode view.
    await followLink(
      page,
      page.getByTestId("episode-care-link"),
      /\/encounters\/\d+/
    );
    await expect(page.getByTestId("encounter-episode-trail")).toContainText(
      "During illness episode: sinus infection"
    );
  });
});
