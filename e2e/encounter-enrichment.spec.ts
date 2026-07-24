import { test, expect, type Page } from "@playwright/test";
import { loginAs } from "./nav";
import { settledClick, followLink } from "./helpers";
import { E2E_LOGIN_ENCRICH, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Encounter-detail enrichment (#1350) + RecordProvenance deep-link (#1353), driven
// end-to-end as E2E_LOGIN_ENCRICH in its OWN cookie context on a dedicated profile
// (seed-events.ts) — a subject visit with a same-provider prior visit, a completed
// appointment booked for it, an unlinked illness episode spanning it, and a
// document-sourced + a manual condition. Idempotent under --repeat-each: the episode
// link is applied only when the suggestion is still present, then the LINKED end-state
// is asserted, so a second run over the already-linked DB passes.

test.describe("encounter detail enrichment (#1350/#1353)", () => {
  let page: Page;

  test.beforeAll(async ({ browser }) => {
    page = await loginAs(browser, {
      username: E2E_LOGIN_ENCRICH,
      password: E2E_MEMBER_PASSWORD,
    });
  });

  test.afterAll(async () => {
    await page.close();
  });

  // The subject visit is the NEWEST of the two seeded Office Visits (2026-06-18), so
  // the visits list (newest-first) yields it as the first row.
  async function openSubjectVisit() {
    await page.goto("/records/history/visits");
    await followLink(
      page,
      page.getByRole("link", { name: /Office Visit/ }).first(), // first-ok: dedicated ENCRICH fixture profile — the newest of its own two visits is the subject
      /\/encounters\/\d+/
    );
    await expect(page.getByTestId("encounter-detail")).toBeVisible();
  }

  test("hero shows same-provider / same-kind visit context", async () => {
    await openSubjectVisit();
    const context = page.getByTestId("encounter-visit-context");
    await expect(context).toBeVisible();
    await expect(context).toContainText("2nd visit with Dr. Enid Enrich (e2e)");
    await expect(context).toContainText("this year");
  });

  test("provenance chain resolves: scheduling origin + timeline day", async () => {
    await openSubjectVisit();
    // Scheduling origin from the completed appointment booked for this visit.
    await expect(page.getByTestId("encounter-scheduling")).toContainText(
      /Scheduled .* → attended/
    );
    // The timeline-day link resolves to the visit's day in the Timeline.
    await followLink(
      page,
      page.getByTestId("encounter-timeline-link"),
      /\/timeline\?/
    );
  });

  test("links an illness episode from the visit side and shows the care trail", async () => {
    await openSubjectVisit();
    const suggestion = page.getByTestId("link-episode-to-visit");
    if (await suggestion.isVisible().catch(() => false)) {
      await expect(suggestion).toContainText("sinus infection (e2e)");
      await settledClick(page, page.getByTestId("link-episode-suggestion"));
    }
    // Linked end-state: the care trail shows the episode with its shared status line…
    const trail = page.getByTestId("encounter-episode-trail");
    await expect(trail).toBeVisible();
    await expect(trail).toContainText(
      "During illness episode: sinus infection (e2e)"
    );
    // …and it deep-links into the episode view.
    await followLink(
      page,
      page.getByTestId("encounter-episode-trail-item"),
      /\/medical\/episodes\/\d+/
    );
  });

  test("a document-sourced record's provenance deep-links to the source import (#1353)", async () => {
    await page.goto("/conditions");
    await expect(page.getByTestId("record-provenance-link")).toBeVisible();
    // The manual condition keeps a plain (non-link) 'Manual' label — so exactly one
    // provenance deep-link exists on this dedicated profile's list.
    await expect(page.getByTestId("record-provenance-link")).toHaveCount(1);
    await followLink(
      page,
      page.getByTestId("record-provenance-link"),
      /\/import\/\d+/
    );
  });
});
