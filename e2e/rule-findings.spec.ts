import { test, expect } from "@playwright/test";

// Issue #45 (domains 4–6): three deterministic, dismissible observational-findings
// surfaces, each fed by a pure lib rule over data the app already stores and each
// suppressible through the shared findings bus. The seed + e2e fixtures ship a
// plateaued lift (a fixed-load Skullcrusher held flat for ~5 weeks), a probable-error
// day-over-day weight jump, and off-pace weight goals ("Reach 74 kg" / "Cut to
// 78 kg"), so each domain has a finding to render end-to-end against the seeded DB.

// Domain 4 — training balance/plateau on Training → Overview.
test("Training → Overview shows a plateau finding for the flat Skullcrusher (#45)", async ({
  page,
}) => {
  await page.goto("/training?tab=overview");
  const card = page.getByRole("main").getByTestId("training-findings");
  await expect(card).toBeVisible();
  await expect(card).toContainText("Skullcrusher");
  await expect(card).toContainText(/plateaued/i);
  await expect(card).toContainText(/deload/i);
});

// Domain 5 — body-metric data hygiene on Trends → Body.
test("Trends → Body shows a data-hygiene finding for the weight jump (#45)", async ({
  page,
}) => {
  await page.goto("/trends?tab=body");
  const card = page.getByRole("main").getByTestId("body-hygiene-findings");
  await expect(card).toBeVisible();
  await expect(card).toContainText(/unusual weight reading/i);
});

// Domain 6 — goal pacing on Training → Goals.
test("Training → Goals shows an off-pace goal finding (#45)", async ({
  page,
}) => {
  await page.goto("/training?tab=goals");
  const card = page.getByRole("main").getByTestId("goal-pacing-findings");
  await expect(card).toBeVisible();
  await expect(card).toContainText(/off pace/i);
});

// Suppression — dismissing a body-hygiene finding hides it via the shared findings-
// bus store (dismissBodyHygiene → dismissFinding), so it stops rendering.
test("a body-hygiene finding can be dismissed (#45)", async ({ page }) => {
  await page.goto("/trends?tab=body");
  const main = page.getByRole("main");
  const finding = main
    .getByTestId("body-hygiene-findings-item")
    .filter({ hasText: "Unusual weight reading" });
  await expect(finding).toBeVisible();

  await finding.getByTestId("body-hygiene-findings-dismiss").click();

  // After the server action + re-render, that finding is gone (only the one seeded
  // anomaly exists, so the whole card unmounts).
  await expect(
    main
      .getByTestId("body-hygiene-findings-item")
      .filter({ hasText: "Unusual weight reading" })
  ).toHaveCount(0);
});
