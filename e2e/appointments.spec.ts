import { test, expect } from "@playwright/test";

// The Upcoming section of the merged Visits page (issue #288 — appointments and
// encounters share one /encounters surface now). Originally the standalone
// /appointments list (#391, gap 7); retargeted here to the merged page. Asserts a
// seeded scheduled visit renders with its provider inside the Upcoming section, and
// that cancelling the dedicated future appointment both settles its status and
// drops it from the Upcoming feed (list↔digest parity). Also proves the old
// /appointments route redirects into the merged page.

const APPT_UPCOMING = '[data-testid^="upcoming-item-appointment:"]';

test.describe("Visits — Upcoming (appointments) (#288)", () => {
  test("the old /appointments route redirects to the merged Visits page", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/appointments");
    await expect(page).toHaveURL(/\/records\/history\/visits$/);
    await expect(page.getByTestId("records-visits")).toBeVisible();
  });

  test("a seeded scheduled appointment renders with its provider", async ({
    page,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    await page.goto("/records/history/visits");
    await expect(page.getByTestId("records-visits")).toBeVisible();

    // The Upcoming section carries the appointments surface.
    const upcoming = page.getByTestId("visits-upcoming");
    await expect(upcoming).toBeVisible();

    // The seeded, still-scheduled cardiology visit shows with its linked provider.
    const row = upcoming
      .getByTestId("appointment-row")
      .filter({ hasText: "Cardiology follow-up" });
    await expect(row).toBeVisible();
    await expect(row).toContainText("Dr. Marcus Lee");
  });

  test("cancelling an appointment settles its status and clears it from Upcoming", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/records/history/visits");
    const upcoming = page.getByTestId("visits-upcoming");

    // The dedicated future appointment while it's still scheduled (only scheduled
    // rows carry the Cancel control). Guarded so a CI retry — where it's already
    // cancelled — skips straight to the assertions.
    const scheduledRow = upcoming
      .getByTestId("appointment-row")
      .filter({ hasText: "E2E dermatology visit" })
      .filter({
        has: page.getByRole("button", { name: "Cancel appointment" }),
      });
    if (await scheduledRow.count()) {
      await scheduledRow
        .getByRole("button", { name: "Cancel appointment" })
        .click();
      // It leaves the Scheduled list (its status is no longer "scheduled").
      await expect(scheduledRow).toHaveCount(0);
    }

    // Its status settled to Cancelled — visible once the settled-history section
    // is expanded.
    await page.getByText(/Completed & cancelled/).click();
    const settledRow = upcoming
      .getByTestId("appointment-row")
      .filter({ hasText: "E2E dermatology visit" });
    await expect(settledRow).toContainText("Cancelled");

    // And it's gone from the Upcoming feed.
    await page.goto("/upcoming");
    await expect(
      page.locator(APPT_UPCOMING).filter({ hasText: "E2E dermatology visit" })
    ).toHaveCount(0);
  });
});

// The single "Add visit" entry (issue #566): one affordance that branches on
// tense instead of two separate add forms. These cases prove the branch selection
// only — the tense toggle swaps the appointment↔encounter shape, and the date the
// user enters routes to the matching shape — without saving anything (no DB
// mutation, so no fixture cleanup). The end-to-end save of each branch is covered
// by visits-lifecycle.spec (appointment) and encounters.spec (encounter).
test.describe("Visits — single Add visit entry (#566)", () => {
  test("the tense toggle swaps between the appointment and encounter branches", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/records/history/visits");
    const add = page.getByTestId("visits-add");
    await expect(add).toBeVisible();

    // Default branch is the appointment (future / scheduling) shape.
    await expect(add.getByLabel("Reason / title")).toBeVisible();
    await expect(add.getByLabel("Kind (optional)")).toBeVisible();
    await expect(add.getByLabel("Diagnoses")).toHaveCount(0);

    // "Already happened" reveals the encounter (past / clinical) shape.
    await add.getByTestId("visit-tense-past").click();
    await expect(add.getByLabel("Diagnoses")).toBeVisible();
    await expect(add.getByLabel("Reason (chief complaint)")).toBeVisible();
    await expect(add.getByLabel("Kind (optional)")).toHaveCount(0);

    // …and back to the appointment shape.
    await add.getByTestId("visit-tense-upcoming").click();
    await expect(add.getByLabel("Kind (optional)")).toBeVisible();
    await expect(add.getByLabel("Diagnoses")).toHaveCount(0);
  });

  test("a past date routes the entry to the encounter branch, a future date to the appointment branch", async ({
    page,
  }) => {
    test.slow();

    await page.goto("/records/history/visits");
    const add = page.getByTestId("visits-add");
    await expect(add).toBeVisible();

    // Starts on the appointment branch; entering a clearly-past date flips the
    // entry to the encounter (clinical) shape — the "pick a date first" routing.
    await expect(add.getByLabel("Kind (optional)")).toBeVisible();
    await add.getByLabel("Date", { exact: true }).fill("2020-01-15");
    await expect(add.getByLabel("Diagnoses")).toBeVisible();

    // A clearly-future date flips it back to the appointment (scheduling) shape.
    await add.getByLabel("Date", { exact: true }).fill("2099-01-15");
    await expect(add.getByLabel("Kind (optional)")).toBeVisible();
  });
});
