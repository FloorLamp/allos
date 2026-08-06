import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { followLink, hydratedClick } from "./helpers";
import { workerDbPath } from "./worker-env";

// The appointment → encounter lifecycle on the merged Visits page (issue #288):
// book → complete → "Log this visit" → the linked visit lands in Past → click
// through to its detail. Drives the real UI end-to-end on the merged /encounters
// surface. Uses a unique title marker so the fixture is self-cleaning and
// idempotent across CI retries (a raw connection, like encounters.spec, avoids
// re-running migrate()/bootstrap on import).
const DB_PATH = workerDbPath();
const MARKER = "E2E lifecycle physical";
const STALE_MARKER = "E2E stale double complete";

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    // Appointments hold the encounter_id FK, so drop them BEFORE their encounters.
    handle.prepare("DELETE FROM appointments WHERE title = ?").run(MARKER);
    handle
      .prepare("DELETE FROM appointments WHERE title = ?")
      .run(STALE_MARKER);
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

    await page.goto("/records/history/visits");
    const upcoming = page.getByTestId("visits-upcoming");
    await expect(upcoming).toBeVisible();

    // Book through the shared Add visit modal (date defaults to today, so the row
    // is scheduled and actionable).
    await hydratedClick(page, page.getByTestId("add-visit-panel-toggle"));
    const visitDialog = page.getByRole("dialog", { name: "Add visit" });
    await visitDialog.getByLabel("Reason / title").fill(MARKER);
    await visitDialog.getByLabel("Kind (optional)").selectOption("physical");
    await visitDialog.getByLabel("Provider").fill("E2E Lifecycle Clinic");
    await visitDialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Appointment saved")).toBeVisible();

    // Complete the just-booked appointment. Its row carries the Mark-completed
    // control while scheduled.
    const row = upcoming
      .getByTestId("appointment-row")
      .filter({ hasText: MARKER });
    await expect(row).toBeVisible({ timeout: 15_000 });
    await row.getByRole("button", { name: "Mark completed" }).click();

    // The close-the-loop panel offers to log the visit; take it.
    await upcoming.getByTestId("log-visit").click();
    await expect(page.getByText("Visit logged")).toBeVisible();

    // The linked visit now appears in the Past section with the kind mapped to its
    // encounter type, and deep-links to its detail page.
    const past = page.getByTestId("visits-past");
    const visitLink = past
      .getByRole("link", { name: "Physical / check-up" })
      .first(); // first-ok: the visit THIS spec just logged, in its own Past section — order-agnostic
    await expect(visitLink).toBeVisible({ timeout: 15_000 });
    await expect(visitLink).toHaveAttribute("href", /\/encounters\/\d+$/);

    // Nav anchor → followLink rides out the pre-hydration swallow (#889 sweep).
    await followLink(page, visitLink, /\/encounters\/\d+$/);
    const detail = page.getByTestId("encounter-detail");
    await expect(detail).toBeVisible();
    // The visit is prefilled from the appointment: the title became the reason.
    await expect(detail.getByTestId("encounter-reason")).toHaveText(MARKER);
  });
});

// #2134: Mark completed rides a compare-and-swap now. A double-tap fires two
// completeAppointment POSTs at the same scheduled row; exactly one lands the
// scheduled→completed transition and the other answers with the typed
// "already" outcome instead of silently re-writing the status — the palette
// and the list render that answer as an honest toast.
test.describe("Appointment double-tap answers 'already completed' (#2134)", () => {
  test.beforeAll(cleanup);
  test.afterAll(cleanup);

  test("double-tapping Mark completed completes once and answers honestly", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/records/history/visits");
    const upcoming = page.getByTestId("visits-upcoming");
    await expect(upcoming).toBeVisible();

    await hydratedClick(page, page.getByTestId("add-visit-panel-toggle"));
    const visitDialog = page.getByRole("dialog", { name: "Add visit" });
    await visitDialog.getByLabel("Reason / title").fill(STALE_MARKER);
    await visitDialog.getByRole("button", { name: "Add", exact: true }).click();
    await expect(page.getByText("Appointment saved")).toBeVisible();

    const row = upcoming
      .getByTestId("appointment-row")
      .filter({ hasText: STALE_MARKER });
    await expect(row).toBeVisible({ timeout: 15_000 });

    // Two click events before any re-render can withdraw the button: both taps
    // reach the Server Action, the CAS lets exactly one transition land, and
    // the loser's typed outcome surfaces as the honest toast.
    await row.getByRole("button", { name: "Mark completed" }).dblclick();
    await expect(page.getByText("Appointment already completed")).toBeVisible();

    // One completion: the revalidated page moves the row out of the scheduled
    // list (Mark completed withdrawn) and it settles ONCE into the
    // Completed & cancelled fold — not cancelled, not duplicated.
    await expect(
      row.filter({
        has: page.getByRole("button", { name: "Mark completed" }),
      })
    ).toHaveCount(0);
    await expect(row).toHaveCount(1);
    await page.getByText("Completed & cancelled").click();
    await expect(row.getByRole("button", { name: "Reopen" })).toBeVisible();
  });
});
