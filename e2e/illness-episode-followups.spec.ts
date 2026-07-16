import { test, expect } from "@playwright/test";
import { followLink } from "./nav";

// Illness-episode follow-ups (#856). The seed makes profile 1 currently sick with an
// OPEN "Illness" episode (a stored row) plus a PAST closed one. These specs drive the
// new surfaces: in-place logging on the episode page (item 11, the SHARED SymptomLogBar),
// the episodes index (item 9), and boundary/annotation editing (item 1). The full-arc
// END behavior is covered by the action-tier test (ending the seed's live episode here
// would race sibling specs that depend on profile 1 staying sick); the button presence
// is asserted below.

test.describe("Illness-episode follow-ups (#856)", () => {
  test("log a symptom AND a temperature from the episode page (item 11)", async ({
    page,
  }) => {
    test.slow();
    // Reach the open episode via the dashboard Symptoms card's "Episode" link.
    await page.goto("/");
    const episodeLink = page
      .getByRole("link", { name: "Episode", exact: true })
      .first();
    await followLink(page, episodeLink, /\/medical\/episodes\/\d+/);

    // The shared logging bar + the fever chart render on the page.
    await expect(page.getByTestId("episode-log-panel")).toBeVisible();
    await expect(page.getByTestId("symptom-log-bar")).toBeVisible();
    await expect(page.getByTestId("episode-fever-chart")).toBeVisible();

    // The "Feeling better" end action is offered on an open episode (item 2 UI).
    await expect(page.getByTestId("episode-end-form")).toBeVisible();

    // Log a symptom at a severity from the episode page.
    const sore3 = page.getByTestId("symptom-sore_throat-sev-3");
    await sore3.click();
    await expect(sore3).toHaveAttribute("aria-pressed", "true");

    // Log a temperature from the episode page.
    await page.getByTestId("temp-quick-input").fill("101.2");
    await page.getByTestId("temp-quick-save").click();
    await expect(page.getByText(/Temperature logged/i)).toBeVisible();
  });

  test("the episodes index lists episodes and links to the detail (item 9)", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/medical/episodes");
    await expect(
      page.getByRole("heading", { name: "Illness episodes" })
    ).toBeVisible();
    const rows = page.getByTestId("episode-index-row");
    await expect(rows.first()).toBeVisible();
    expect(await rows.count()).toBeGreaterThanOrEqual(2); // open + past (seed)

    // Following a row opens its detail page.
    await followLink(page, rows.first(), /\/medical\/episodes\/\d+/);
    await expect(
      page.getByRole("heading", { name: /Illness episode/ })
    ).toBeVisible();
  });

  test("edit a past episode's outcome + note as a plain row edit (item 1)", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/medical/episodes");
    // The PAST (resolved) episode — pick a row that isn't the ongoing one.
    const resolvedRow = page
      .getByTestId("episode-index-row")
      .filter({ hasText: "Self-resolved" })
      .first();
    await followLink(page, resolvedRow, /\/medical\/episodes\/\d+/);

    await page.getByTestId("episode-edit-open").click();
    await page
      .getByTestId("episode-outcome-input")
      .fill("Recovered without a visit");
    await page
      .getByTestId("episode-note-input")
      .fill("Rested; plenty of fluids");
    await page.getByRole("button", { name: "Save" }).click();

    // The outcome + note persist on the summary.
    await expect(page.getByText("Recovered without a visit")).toBeVisible();
    await expect(page.getByText("Rested; plenty of fluids")).toBeVisible();
  });
});
