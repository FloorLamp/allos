import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";

// The appointment → encounter lifecycle on the merged Visits page (issue #288):
// book → complete → "Log this visit" → the linked visit lands in Past → click
// through to its detail. Drives the real UI end-to-end on the merged /encounters
// surface. Uses a unique title marker so the fixture is self-cleaning and
// idempotent across CI retries (a raw connection, like encounters.spec, avoids
// re-running migrate()/bootstrap on import).
const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";
const MARKER = "E2E lifecycle physical";

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    // Appointments hold the encounter_id FK, so drop them BEFORE their encounters.
    handle.prepare("DELETE FROM appointments WHERE title = ?").run(MARKER);
    handle.prepare("DELETE FROM encounters WHERE reason = ?").run(MARKER);
  } finally {
    handle.close();
  }
}

test.describe("Visits lifecycle — book → complete → log visit → detail (#288)", () => {
  test.beforeAll(cleanup);
  test.afterAll(cleanup);

  test("logging a completed appointment creates a linked, prefilled visit", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/encounters");
    const upcoming = page.getByTestId("visits-upcoming");
    await expect(upcoming).toBeVisible();

    // Book an appointment in the Upcoming section (date defaults to today, so the
    // row is scheduled and actionable). Scope every field to the booking form.
    await upcoming.getByLabel("Reason / title").fill(MARKER);
    await upcoming.getByLabel("Kind (optional)").selectOption("physical");
    await upcoming.getByLabel("Provider").fill("E2E Lifecycle Clinic");
    await upcoming.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Appointment saved")).toBeVisible();

    // Complete the just-booked appointment. Its row carries the Mark-completed
    // control while scheduled.
    const row = upcoming
      .getByTestId("appointment-row")
      .filter({ hasText: MARKER });
    await expect(row).toBeVisible();
    await row.getByRole("button", { name: "Mark completed" }).click();

    // The close-the-loop panel offers to log the visit; take it.
    await upcoming.getByTestId("log-visit").click();
    await expect(page.getByText("Visit logged")).toBeVisible();

    // The linked visit now appears in the Past section with the kind mapped to its
    // encounter type, and deep-links to its detail page.
    const past = page.getByTestId("visits-past");
    const visitLink = past.getByRole("link", { name: "Physical / check-up" });
    await expect(visitLink.first()).toBeVisible();
    await expect(visitLink.first()).toHaveAttribute(
      "href",
      /\/encounters\/\d+$/
    );

    await visitLink.first().click();
    await expect(page).toHaveURL(/\/encounters\/\d+$/);
    const detail = page.getByTestId("encounter-detail");
    await expect(detail).toBeVisible();
    // The visit is prefilled from the appointment: the title became the reason.
    await expect(detail.getByTestId("encounter-reason")).toHaveText(MARKER);
  });
});
