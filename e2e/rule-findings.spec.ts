import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { settledClick } from "./helpers";
import { loginAs } from "./nav";
import { E2E_LOGIN_GOAL_PACE, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// Issue #45 (domains 4–6): three deterministic, dismissible observational-findings
// surfaces, each fed by a pure lib rule over data the app already stores and each
// suppressible through the shared findings bus. The e2e fixtures ship a plateaued
// lift (a fixed-load Skullcrusher held flat for ~5 weeks) and a probable-error
// day-over-day weight jump on profile 1, plus a whole dedicated profile for goal
// pacing (seedGoalPacing, #2353), so each domain has a finding to render end-to-end.

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
  await page.goto("/trends");
  const card = page.getByRole("main").getByTestId("body-hygiene-findings");
  await expect(card).toBeVisible();
  await expect(card).not.toHaveAttribute("open", "");
  await card.getByTestId("body-hygiene-findings-toggle").click();
  await expect(card).toContainText(/unusual weight reading/i);
});

// Domain 6 — goal pacing on Training → Goals, on its OWN profile (#2353).
//
// This case used to run as the shared admin against profile 1's seeded weight goals.
// Goal pacing is a verdict over the profile's WEIGHT SERIES, and profile 1's series
// is shared with every spec that logs a weight — one earlier test saving 72.5 kg
// (palette-actions' "Log weight", #2184) re-fit the pace steeply downwards, both
// seeded goals then read as reaching EARLY, and this card rendered nothing. Since
// Playwright shards by test index, adding any spec file anywhere could slide that
// test in front of this one, so an unrelated PR reddened here. The fixture profile
// below is written by nothing else, which is what makes the verdict order-proof.
test("Training → Goals shows an off-pace goal finding (#45)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_GOAL_PACE,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/training?tab=goals");
    const card = page.getByRole("main").getByTestId("goal-pacing-findings");
    await expect(card).toBeVisible();
    await expect(card).toContainText("Reach 82 kg (e2e)");
    await expect(card).toContainText(/off pace/i);
    // The fixture's weight is CREEPING UP against a reduction goal, so the verdict
    // is the "trending away" branch — the one that can't drift back on pace as the
    // frozen clock moves the deadline around.
    await expect(card).toContainText(/trending away/i);
  } finally {
    await page.context().close();
  }
});

// Clears any body-hygiene dismissal so the finding is guaranteed visible before
// the dismiss test — regardless of retries or prior runs against the shared
// seeded DB (the resetPreventiveFixture pattern from #206: a dismissal persists
// in upcoming_dismissals, so a retried test would otherwise find the finding
// already gone at its first assertion). Short-lived connection, busy timeout
// so it never contends with the running server (WAL).
function resetBodyHygieneDismissals(): void {
  const dbPath = workerDbPath();
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
  await page.goto("/trends");
  const main = page.getByRole("main");
  await main.getByTestId("body-hygiene-findings-toggle").click();
  // Target the SEEDED 92 kg anomaly specifically: in the full suite other specs
  // (offline-queue, manual-vitals) log weights of their own before this file runs,
  // which can trip additional >3% findings — a bare "Unusual weight reading"
  // filter then strict-mode-fails on multiple matches.
  const finding = main
    .getByTestId("body-hygiene-findings-item")
    .filter({ hasText: "92 kg" });
  await expect(finding).toBeVisible();

  // Same FindingRow <form action={dismiss}> Server-Action submit as the
  // adherence dismiss.
  await settledClick(
    page,
    finding.getByTestId("body-hygiene-findings-dismiss")
  );

  // After the server action + re-render, THIS finding is gone — other specs'
  // incidental weight findings (if any) legitimately remain.
  await expect(
    main.getByTestId("body-hygiene-findings-item").filter({ hasText: "92 kg" })
  ).toHaveCount(0);
});
