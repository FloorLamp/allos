import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";

// Issue #449 — the four #45 observational domains (training balance/plateau,
// body-metric hygiene, goal pacing, adherence patterns) render only on their own
// tabs. The dashboard "Coaching observations" rollup gives them REACH WITHOUT NOISE:
// the SAME findings (one computation, collectCoachingFindings) surface as a calm,
// hideable dashboard widget, and a dismiss there silences the finding on its origin
// tab too (shared findings bus). The seed + e2e fixtures ship a plateaued Skullcrusher,
// a 92 kg weight glitch, and off-pace weight goals, so the rollup has content on the
// seeded DB.

// Clears any coaching-observation dismissals so the rollup is guaranteed populated
// before each assertion, regardless of retries or prior runs against the shared
// seeded DB (the resetPreventiveFixture pattern from #206: a dismissal persists in
// upcoming_dismissals). BLAST RADIUS: only the four rule-findings namespaces (training
// plateaus, body hygiene, goal pacing, adherence) — the same signal keys the tab specs
// (rule-findings.spec.ts, adherence-patterns.spec.ts) also reset, so it never touches
// preventive/dose/biomarker suppressions other specs depend on. Short-lived
// connection, busy timeout so it never contends with the running server (WAL).
function resetCoachingObservationDismissals(): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      `DELETE FROM upcoming_dismissals
       WHERE signal_key LIKE 'training-obs:%'
          OR signal_key LIKE 'body-hygiene:%'
          OR signal_key LIKE 'goal-pace:%'
          OR signal_key LIKE 'adherence:%'`
    ).run();
  } finally {
    db.close();
  }
}

test("the dashboard surfaces tab-only coaching observations (#449)", async ({
  page,
}) => {
  resetCoachingObservationDismissals();
  await page.goto("/");

  const rollup = page.getByRole("main").getByTestId("coaching-observations");
  await expect(rollup).toBeVisible();
  // The plateaued Skullcrusher lives on Training → Overview; here it's reachable
  // from the dashboard without opening that tab.
  await expect(rollup).toContainText("Skullcrusher");
});

test("dismissing a coaching observation from the dashboard removes it (#449)", async ({
  page,
}) => {
  resetCoachingObservationDismissals();
  await page.goto("/");

  const rollup = page.getByRole("main").getByTestId("coaching-observations");
  await expect(rollup).toBeVisible();

  // Target the Skullcrusher plateau row specifically (a deterministic seeded
  // finding), so other domains' rows legitimately remain after the dismiss.
  const row = rollup
    .getByTestId("coaching-observations-item")
    .filter({ hasText: "Skullcrusher" });
  await expect(row).toBeVisible();

  await row.getByTestId("coaching-observations-dismiss").click();

  // Dismiss writes to the shared suppression store, so THIS finding is gone from
  // the rollup after the re-render.
  await expect(
    rollup
      .getByTestId("coaching-observations-item")
      .filter({ hasText: "Skullcrusher" })
  ).toHaveCount(0);
});
