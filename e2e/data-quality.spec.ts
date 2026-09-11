import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
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

// WHERE THE GAP SITS NOW (#5435 §3.4). The row is the same finding through the same
// bus with the same dismissal identity; what moved is its seat and therefore its id.
// Home's composer keys a Setup row on `home.setup:` plus the bus's own dedupe key, and
// every data-quality gap's dedupe key starts `data-quality:` — so this prefix names
// exactly the rows the retired `data-quality.finding:` candidate id named.
const SETUP_GAP_PREFIX = "home.setup:data-quality:";

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

  const atom = dashboardCandidateWithText(
    page,
    SETUP_GAP_PREFIX,
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
  // Home rendered, and it rendered ROWS — the positive control, without which the
  // absence below would pass just as happily on a page that drew nothing at all.
  const main = page.getByRole("main");
  await expect(main).toBeVisible();
  expect(await main.locator("[data-candidate-id]").count()).toBeGreaterThan(0);
  // …and none of them is a data-quality gap, because there is no structural gap to
  // mint one. The Setup block is absent entirely when the bus has nothing (§3.4).
  await expect(
    main.locator(`[data-candidate-id^="${SETUP_GAP_PREFIX}"]`)
  ).toHaveCount(0);
  await expect(main.getByTestId("home-setup")).toHaveCount(0);

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

  // The data-quality row owns this gap.
  const atom = dashboardCandidateWithText(
    page,
    SETUP_GAP_PREFIX,
    "Set a birthdate"
  );
  await expect(atom).toBeVisible();
  await expect(atom).toContainText("Set a birthdate");
  // …and nothing else on the page says it a second time. The rollup this used to
  // name — `coaching.observation:` — left Home with the rest of the coaching
  // findings (#5435 §4, rewritten by #5634), so the claim is now the stronger one
  // it always meant: ONE row carrying this sentence, counted over every row the
  // page renders rather than over one lane's.
  const gapRows = main
    .locator("[data-candidate-id]")
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
