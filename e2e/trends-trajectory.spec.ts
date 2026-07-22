import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";

// Clears the seeded eGFR trajectory dismissal so the finding is present again — the
// same row-delete the app's own restore path performs (restoreFinding → DELETE FROM
// upcoming_dismissals). The dismiss test below writes a PERSISTENT acknowledgment
// (dismissTrajectory → dismissFinding) under the analyte-level flag key
// `biomarker-flag:egfr` (eGFR is not part of a biomarker family, so
// biomarkerFlagDismissalKey("eGFR") lowercases to that exact key) to the shared
// seeded DB, and nothing else resets it. Under --repeat-each (one server, one DB)
// repeat #2+ of both the presence AND dismiss tests would otherwise find the finding
// already acknowledged and fail on the initial toBeVisible. Resetting before every
// test makes both idempotent regardless of order/retries; the afterAll leaves the
// shared DB clean for neighbors. The delete targets ONLY the eGFR key, so a sibling
// spec's `biomarker-flag:ldl cholesterol` dismissal is untouched. Short-lived
// connection, busy timeout so it never contends with the running server (WAL).
function resetEgfrTrajectoryDismissal(): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      "DELETE FROM upcoming_dismissals WHERE signal_key = 'biomarker-flag:egfr'"
    ).run();
  } finally {
    db.close();
  }
}

test.beforeEach(() => resetEgfrTrajectoryDismissal());
test.afterAll(() => resetEgfrTrajectoryDismissal());

// Issue #41 (biomarker trajectory rules): the Results → Biomarkers section surfaces a
// "Trajectory watch" card listing forward-looking findings — an in-range value
// projected to cross a boundary, a persistent non-optimal pattern, or a concerning
// velocity — BEFORE a single-value flag would catch them. (#1164 moved this card here
// from the deleted Trends → Biomarkers tab.) The seed ships a slow eGFR decline that
// stays above the CKD floor the whole time, so it never trips a range flag but DOES
// fire the velocity + persistent + approaching rules. This proves the pure engine, the
// profile-scoped server assembly, and the rendered card all work end-to-end.
test("Results → Biomarkers shows a trajectory finding for the seeded eGFR decline (#41)", async ({
  page,
}) => {
  await page.goto("/results/biomarkers");

  const card = page.getByTestId("trajectory-findings");
  await expect(card).toBeVisible();
  await expect(card).toContainText("eGFR");
  // The velocity rule's observation names the analyte and its framing.
  await expect(card).toContainText(/eGFR is falling faster than usual/i);
  await expect(card).toContainText(/clinician/i);
});

// The dismiss affordance funnels through the shared findings-bus suppression store
// (dismissTrajectory → dismissFinding). Since #564 it writes the analyte-level
// acknowledgment key (`biomarker-flag:<family>`) shared with the dashboard flag, so
// dismissing ONE of the analyte's trajectory findings silences the whole analyte's
// trajectory watch (both views of one concern), not just that one rule.
test("dismissing a trajectory finding silences the analyte's trajectory watch (#41/#564)", async ({
  page,
}) => {
  await page.goto("/results/biomarkers");

  const finding = page
    .getByTestId("trajectory-finding")
    .filter({ hasText: "eGFR is falling faster than usual" });
  await expect(finding).toBeVisible();

  await finding.getByTestId("trajectory-dismiss").click();

  // After the server action + re-render, every eGFR trajectory finding is gone
  // (the analyte-level acknowledgment, not just the velocity rule).
  await expect(
    page.getByTestId("trajectory-finding").filter({ hasText: "eGFR" })
  ).toHaveCount(0);
});
