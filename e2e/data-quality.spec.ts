import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { openDashboardAll, settledClick } from "./helpers";
import {
  E2E_LOGIN_DQ_GAPPY,
  E2E_LOGIN_DQ_COMPLETE,
  E2E_LOGIN_DQ_CARE,
  DQ_GAPPY_PROFILE,
  DQ_CARE_CHILD_PROFILE,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";
import { dashboardCandidateWithText } from "./dashboard-candidate";

// Structural data-quality gaps (issue #1045). One pure gap model, many formatters: a
// atomic dashboard statements (ranked by leverage, with no score), the
// coaching surfaces (a dismiss anywhere silences everywhere through the shared bus),
// and a household per-member gaps line. Since #1533 the dashboard shows each gap in
// exactly once: data-quality and coaching-observation candidates are disjoint. The
// seeded fixtures ship a gappy sole profile, a complete profile, and a caregiver
// with a gappy child.

// Clears the gappy profile's data-quality dismissals so the atom is guaranteed
// populated before each assertion, regardless of retries or a prior dismiss test
// (the resetCoachingObservationDismissals pattern from #206/#449). BLAST RADIUS: only
// the `data-quality:` namespace on the gappy fixture profile.
function resetDataQualityDismissals(profileName: string): void {
  const dbPath = workerDbPath();
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    const row = db
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(profileName) as { id: number } | undefined;
    if (row) {
      db.prepare(
        `DELETE FROM upcoming_dismissals
          WHERE profile_id = ? AND signal_key LIKE 'data-quality:%'`
      ).run(row.id);
    }
  } finally {
    db.close();
  }
}

test("the dashboard surfaces the highest-leverage data-quality gap with a fix-it CTA (#1045)", async ({
  browser,
}) => {
  resetDataQualityDismissals(DQ_GAPPY_PROFILE);
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DQ_GAPPY,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/");
  await openDashboardAll(page);

  const atom = dashboardCandidateWithText(
    page,
    "data-quality.finding:",
    "Set a birthdate"
  );
  await expect(atom).toBeVisible();
  // The highest-leverage gap (no birthdate → age unknown) leads, and each row carries
  // a fix-it CTA link (an EXISTING explicit-entry surface, never an auto-fix).
  // The row IS the finding since #4076 — one gap, one candidate, one row — and it
  // still carries a fix-it CTA link (an EXISTING explicit-entry surface, never an
  // auto-fix).
  await expect(atom.getByRole("link", { name: "Fix it" })).toBeVisible();
  // NO score / percentage ring — a count and a list.
  await expect(atom).not.toContainText("%");

  await page.context().close();
});

test("a structurally complete profile emits no Data quality candidate (#1045)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DQ_COMPLETE,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/");
  await openDashboardAll(page);
  // The dashboard rendered successfully…
  await expect(page.getByRole("main")).toBeVisible();
  // …but there is no structural gap to mint a data-quality candidate.
  await expect(
    page
      .getByRole("main")
      .locator('[data-candidate-id^="data-quality.finding:"]')
  ).toHaveCount(0);

  await page.context().close();
});

test("a structural gap renders EXACTLY ONCE on the dashboard (#1533)", async ({
  browser,
}) => {
  resetDataQualityDismissals(DQ_GAPPY_PROFILE);
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DQ_GAPPY,
    password: E2E_MEMBER_PASSWORD,
  });
  const main = page.getByRole("main");
  await page.goto("/");
  await openDashboardAll(page);

  // The data-quality candidate owns this gap.
  const atom = dashboardCandidateWithText(
    page,
    "data-quality.finding:",
    "Set a birthdate"
  );
  await expect(atom).toBeVisible();
  await expect(atom).toContainText("Set a birthdate");
  // …and the Coaching-observations rollup defers: the gap is NOT a second row a
  // screen further down (which is what the mobile stack used to show).
  await expect(
    main
      .getByTestId("dashboard-candidate")
      .filter({ hasText: "Set a birthdate" })
      .filter({
        has: main.locator('[data-candidate-id^="coaching.observation:"]'),
      })
  ).toHaveCount(0);
  // One row on the whole dashboard, not two — counted across every zone.
  const gapRows = main
    .getByTestId("dashboard-candidate")
    .filter({ hasText: "Set a birthdate" });
  await expect(gapRows).toHaveCount(1);

  // Dismissing the atom still writes to the shared suppression bus.
  await settledClick(page, atom.getByTestId("finding-dismiss"));
  await expect(gapRows).toHaveCount(0);

  await page.context().close();
});

test("the household page shows a per-member data-quality gaps line (#1045)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DQ_CARE,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/household");

  // Locate the gappy child's card by its avatar name, then assert its gaps line.
  const childCard = page
    .getByTestId("household-card")
    .filter({ hasText: DQ_CARE_CHILD_PROFILE });
  await expect(childCard).toBeVisible();
  const gapsLine = childCard.getByTestId("household-data-quality");
  await expect(gapsLine).toBeVisible();
  await expect(gapsLine).toContainText("birthdate");

  await page.context().close();
});
