import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";

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

// Clears any body-hygiene dismissal so the finding is guaranteed visible before
// the dismiss test — regardless of retries or prior runs against the shared
// seeded DB (the resetPreventiveFixture pattern from #206: a dismissal persists
// in upcoming_dismissals, so a retried test would otherwise find the finding
// already gone at its first assertion). Short-lived connection, busy timeout
// so it never contends with the running server (WAL).
function resetBodyHygieneDismissals(): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      "DELETE FROM upcoming_dismissals WHERE signal_key LIKE 'body-hygiene:%'"
    ).run();
  } finally {
    db.close();
  }
}

// Suppression — dismissing a body-hygiene finding hides it via the shared findings-
// bus store (dismissBodyHygiene → dismissFinding), so it stops rendering.
test("a body-hygiene finding can be dismissed (#45)", async ({ page }) => {
  resetBodyHygieneDismissals();
  await page.goto("/trends?tab=body");
  const main = page.getByRole("main");
  // Target the SEEDED 92 kg anomaly specifically: in the full suite other specs
  // (offline-queue, manual-vitals) log weights of their own before this file runs,
  // which can trip additional >3% findings — a bare "Unusual weight reading"
  // filter then strict-mode-fails on multiple matches.
  const finding = main
    .getByTestId("body-hygiene-findings-item")
    .filter({ hasText: "92 kg" });
  await expect(finding).toBeVisible();

  await finding.getByTestId("body-hygiene-findings-dismiss").click();

  // After the server action + re-render, THIS finding is gone — other specs'
  // incidental weight findings (if any) legitimately remain.
  await expect(
    main.getByTestId("body-hygiene-findings-item").filter({ hasText: "92 kg" })
  ).toHaveCount(0);
});
