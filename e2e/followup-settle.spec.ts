import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { hydratedClick, settledClick } from "./helpers";
import { workerDbPath, frozenNow } from "./worker-env";

// The finding follow-up TERMINATOR (issue #1866): the first-class resolve/decline
// action on the Upcoming row — the only permanent off-switch for the overdue
// follow-up push escalation. Drives the real UI end-to-end:
//   - "Not doing it…" (+ optional reason) closes the chain node as declined: the
//     row drops off Upcoming, the imaging list's state chip says "declined" (never
//     "due"), and the care-plan overview records the reason;
//   - "Done…" with a stated past date closes it as done.
//
// Fixture discipline (#868): rows are seeded directly (this spec OWNS them) under a
// unique impression/region tag, for the acting profile 1, and cleaned up in
// beforeAll AND afterAll (care_plan_items before their imaging_studies FK parents).
// Dates derive from the run's frozen clock (frozenNow), shifted well past any
// week-mode boundary — never wall-clock.
const DB_PATH = workerDbPath();
const REGION = "E2EFUSETTLE";
const IMPRESSION = "6 mm nodule E2EFUSETTLE";

function iso(daysFromNow: number): string {
  const d = frozenNow();
  d.setUTCDate(d.getUTCDate() + daysFromNow);
  return d.toISOString().slice(0, 10);
}

function cleanup() {
  const handle = new Database(DB_PATH);
  try {
    handle.pragma("busy_timeout = 5000");
    handle
      .prepare(
        `DELETE FROM care_plan_items
           WHERE source_imaging_study_id IN (
             SELECT id FROM imaging_studies WHERE body_region = ?
           )`
      )
      .run(REGION);
    handle
      .prepare("DELETE FROM imaging_studies WHERE body_region = ?")
      .run(REGION);
  } finally {
    handle.close();
  }
}

// Seed one OVERDUE tracked follow-up for profile 1 directly (the track flow itself
// is followup.spec.ts's job). Returns { studyId, cpId }.
function seedOverdueFollowUp(): { studyId: number; cpId: number } {
  const handle = new Database(DB_PATH);
  try {
    handle.pragma("busy_timeout = 5000");
    const studyId = Number(
      handle
        .prepare(
          `INSERT INTO imaging_studies
             (profile_id, modality, body_region, contrast, study_date, impression)
           VALUES (1, 'ct', ?, 0, ?, ?)`
        )
        .run(REGION, iso(-120), IMPRESSION).lastInsertRowid
    );
    // The description carries the study id so repeated runs against one worker DB
    // (--repeat-each) never produce two identically-named care-plan rows.
    const cpId = Number(
      handle
        .prepare(
          `INSERT INTO care_plan_items
             (description, category, planned_date, status, source_kind,
              source_imaging_study_id, recommended_interval_days, profile_id)
           VALUES (?, 'follow-up', ?, NULL, 'imaging', ?, 30, 1)`
        )
        .run(`Follow-up CT ${REGION} S${studyId}`, iso(-30), studyId)
        .lastInsertRowid
    );
    return { studyId, cpId };
  } finally {
    handle.close();
  }
}

test.describe("Follow-up terminator — resolve/decline on Upcoming (#1866)", () => {
  test.beforeAll(cleanup);
  test.afterAll(cleanup);

  test("declining ends the follow-up: row drops, chip says declined, reason recorded", async ({
    page,
  }) => {
    test.slow();
    const { studyId, cpId } = seedOverdueFollowUp();

    await page.goto("/upcoming");
    const row = page.getByTestId(`upcoming-item-followup:${cpId}`);
    await expect(row).toBeVisible();
    // Overdue ⇒ the terminator offer is inline on the row.
    await hydratedClick(
      page,
      page.getByTestId(`followup-settle-decline-${cpId}`)
    );
    const form = page.getByTestId(`followup-settle-form-${cpId}`);
    await expect(form).toBeVisible();
    await form
      .getByLabel("Reason (optional)")
      .fill("Discussed with clinician — not pursuing");
    await settledClick(page, form.getByRole("button", { name: "Decline" }));

    // The finding is gone — a terminal close, not a suppression.
    await expect(
      page.getByTestId(`upcoming-item-followup:${cpId}`)
    ).toHaveCount(0);

    // The imaging list's state chip tells the truth (never "due <date>").
    await page.goto("/results/imaging");
    await expect(
      page.getByTestId(`imaging-followup-state-${studyId}`)
    ).toHaveText("Follow-up: declined");

    // The care-plan overview records the decision + the free-text reason. Since
    // the #1804 hub redesign the section sits behind a <details> disclosure; the
    // #care-plan hash reveals it (the same navigation care-plan.spec.ts uses).
    await page.goto("/records/care/overview#care-plan");
    const careRow = page
      .locator("tr")
      .filter({ hasText: `Follow-up CT ${REGION} S${studyId}` });
    await expect(careRow).toContainText("Declined");
    await expect(careRow).toContainText(
      "Discussed with clinician — not pursuing"
    );
  });

  test("done on a stated past date ends it identically", async ({ page }) => {
    test.slow();
    const { studyId, cpId } = seedOverdueFollowUp();

    await page.goto("/upcoming");
    await expect(
      page.getByTestId(`upcoming-item-followup:${cpId}`)
    ).toBeVisible();
    await hydratedClick(page, page.getByTestId(`followup-settle-done-${cpId}`));
    const form = page.getByTestId(`followup-settle-form-${cpId}`);
    await form.getByTestId(`followup-settle-date-${cpId}`).fill(iso(-10));
    // Close the DateField's calendar popover so it can't intercept the submit.
    await page.keyboard.press("Escape");
    await settledClick(page, form.getByRole("button", { name: "Mark done" }));

    await expect(
      page.getByTestId(`upcoming-item-followup:${cpId}`)
    ).toHaveCount(0);
    await page.goto("/results/imaging");
    await expect(
      page.getByTestId(`imaging-followup-state-${studyId}`)
    ).toHaveText("Follow-up: done");
  });
});
