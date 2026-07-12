import { test, expect } from "@playwright/test";

// Issue #41 (biomarker trajectory rules): the Trends → Biomarkers area surfaces a
// "Trajectory watch" card listing forward-looking findings — an in-range value
// projected to cross a boundary, a persistent non-optimal pattern, or a concerning
// velocity — BEFORE a single-value flag would catch them. The seed ships a slow
// eGFR decline that stays above the CKD floor the whole time, so it never trips a
// range flag but DOES fire the velocity + persistent + approaching rules. This
// proves the pure engine, the profile-scoped server assembly, and the rendered
// card all work end-to-end against the seeded DB.
test("Trends → Biomarkers shows a trajectory finding for the seeded eGFR decline (#41)", async ({
  page,
}) => {
  await page.goto("/trends?tab=biomarkers");

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
  await page.goto("/trends?tab=biomarkers");

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
