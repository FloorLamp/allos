import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import { openCommandPalette } from "./nav";
import { settledClick } from "./helpers";

// Per-hit command-palette actions (issue #662): a FOUND entity offers contextual
// actions routed through the EXISTING gated Server Actions — med → Log dose /
// Refill, appointment → Mark complete, biomarker → Add result. These drive the
// palette end-to-end (query → server action → ranked hit → rendered action chip →
// gated write / prefilled navigate).
//
// The completing-an-appointment case MUTATES, so it owns a uniquely-titled
// appointment it creates and deletes (the visits-lifecycle #288 self-cleaning
// pattern) — never a shared-seed row a neighbor exact-counts.
const DB_PATH = process.env.ALLOS_DB_PATH ?? "./e2e/.data/e2e.db";
const APPT_MARKER = "E2E palette complete visit";

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    handle.prepare("DELETE FROM appointments WHERE title = ?").run(APPT_MARKER);
  } finally {
    handle.close();
  }
}

test.describe("command palette — per-hit actions (#662)", () => {
  // A biomarker hit offers "Add result": a navigate to the Biomarkers add form,
  // name-prefilled with the canonical analyte. Non-mutating, so it runs on the
  // shared seed (LDL Cholesterol is a seeded canonical biomarker).
  test("a biomarker hit's 'Add result' opens the add form name-prefilled", async ({
    page,
  }) => {
    await page.goto("/");
    const input = await openCommandPalette(page);
    await input.fill("LDL Cholesterol");

    const results = page.getByRole("listbox", { name: "Results" });
    await expect(
      results.getByText("Biomarkers", { exact: true })
    ).toBeVisible();
    const addResult = results
      .getByTestId("palette-hit-action-add-result")
      .first();
    await expect(addResult).toBeVisible();

    // The chip drives a client navigation (router.push) — retry the URL assertion
    // past the pre-hydration window rather than a networkidle gate.
    await addResult.click();
    await expect(page).toHaveURL(/\/biomarkers\?.*name=LDL(\+|%20)Cholesterol/);

    // The add form's Name field is prefilled with the analyte the user searched.
    await expect(page.locator("#rec-new-name")).toHaveValue("LDL Cholesterol");
  });

  // A medication hit (an intake_items row with kind='medication') offers "Log dose"
  // always and "Refill" when it tracks supply. Seed's Sertraline is a supply-tracked
  // medication, so BOTH chips render. Non-mutating — asserts the chips are present
  // (proving searchAll attaches the write actions and the palette renders them for
  // the medication kind); the write dispatch itself is exercised below.
  test("a medication hit renders Log dose and Refill chips", async ({
    page,
  }) => {
    await page.goto("/");
    const input = await openCommandPalette(page);
    await input.fill("Sertraline");

    const results = page.getByRole("listbox", { name: "Results" });
    const row = results
      .getByRole("listitem")
      .filter({ hasText: "Sertraline" })
      .first();
    await expect(row).toBeVisible();
    await expect(
      row.getByTestId("palette-hit-action-log-dose")
    ).toBeVisible();
    await expect(row.getByTestId("palette-hit-action-refill")).toBeVisible();
  });

  // An appointment hit offers "Mark complete" while scheduled, dispatched through
  // the existing completeAppointment Server Action (its auth gate, never a bypass).
  test.describe("completing an appointment from search", () => {
    test.beforeAll(cleanup);
    test.afterAll(cleanup);

    test("the 'Mark complete' action completes the appointment", async ({
      page,
    }) => {
      test.slow();

      // Book a scheduled appointment we own (date defaults to today → scheduled).
      await page.goto("/encounters");
      const upcoming = page.getByTestId("visits-upcoming");
      await expect(upcoming).toBeVisible();
      await upcoming.getByLabel("Reason / title").fill(APPT_MARKER);
      await upcoming.getByRole("button", { name: "Add", exact: true }).click();
      await expect(page.getByText("Appointment saved")).toBeVisible();

      // Find it in the palette and complete it from the hit's action chip.
      const input = await openCommandPalette(page);
      await input.fill(APPT_MARKER);
      const results = page.getByRole("listbox", { name: "Results" });
      const row = results
        .getByRole("listitem")
        .filter({ hasText: APPT_MARKER })
        .first();
      await expect(row).toBeVisible();
      const complete = row.getByTestId("palette-hit-action-complete");
      await expect(complete).toBeVisible();
      // settledClick awaits the completeAppointment POST before returning.
      await settledClick(page, complete);

      // It settled to completed: back on the Visits page it no longer carries the
      // scheduled-only Cancel control in the Upcoming feed.
      await page.goto("/encounters");
      const scheduledRow = page
        .getByTestId("visits-upcoming")
        .getByTestId("appointment-row")
        .filter({ hasText: APPT_MARKER })
        .filter({
          has: page.getByRole("button", { name: "Cancel appointment" }),
        });
      await expect(scheduledRow).toHaveCount(0);
    });
  });
});
