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

// Structural data-quality gaps (issue #1045). One pure gap model, many formatters: a
// dedicated dashboard widget (top-3 by leverage, no score — a count and a list), the
// coaching surfaces (a dismiss anywhere silences everywhere through the shared bus),
// and a household per-member gaps line. Since #1533 the dashboard shows each gap in
// exactly ONE card: the widget is the family's dedicated home, and the Coaching-
// observations rollup carries them only while that widget is hidden. The seeded fixtures (seed-events.ts) ship a
// GAPPY sole profile (no birthdate/sex + a failed doc), a COMPLETE profile (widget
// self-hides), and a caregiver with a gappy child.

// Clears the gappy profile's data-quality dismissals so the widget is guaranteed
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

test("the dashboard Data quality widget renders top gaps with fix-it CTAs (#1045)", async ({
  browser,
}) => {
  resetDataQualityDismissals(DQ_GAPPY_PROFILE);
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DQ_GAPPY,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/");

  const widget = page.getByRole("main").getByTestId("data-quality");
  await expect(widget).toBeVisible();
  // The highest-leverage gap (no birthdate → age unknown) leads, and each row carries
  // a fix-it CTA link (an EXISTING explicit-entry surface, never an auto-fix).
  const birthdate = widget
    .getByTestId("data-quality-item")
    .filter({ hasText: "Set a birthdate" });
  await expect(birthdate).toBeVisible();
  await expect(birthdate.getByRole("link")).toBeVisible();
  // NO score / percentage ring — a count and a list.
  await expect(widget).not.toContainText("%");

  await page.context().close();
});

test("the Data quality widget self-hides on a structurally-complete profile (#1045)", async ({
  browser,
}) => {
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DQ_COMPLETE,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/");
  // The dashboard rendered (a known widget is present)…
  await expect(page.getByRole("main")).toBeVisible();
  // …but the data-quality widget is absent (the absent-pillar rule).
  await expect(page.getByRole("main").getByTestId("data-quality")).toHaveCount(
    0
  );

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

  // The Data quality widget is this family's dedicated dashboard home, so it owns
  // the gap…
  const widget = main.getByTestId("data-quality");
  await expect(widget).toBeVisible();
  await expect(
    widget
      .getByTestId("data-quality-item")
      .filter({ hasText: "Set a birthdate" })
  ).toBeVisible();
  // …and the Coaching-observations rollup defers: the gap is NOT a second row a
  // screen further down (which is what the mobile stack used to show).
  await expect(
    main
      .getByTestId("coaching-observations-item")
      .filter({ hasText: "Set a birthdate" })
  ).toHaveCount(0);
  // One row on the whole dashboard, not two — counted across BOTH cards' rows.
  const gapRows = main
    .locator(
      '[data-testid="data-quality-item"], [data-testid="coaching-observations-item"]'
    )
    .filter({ hasText: "Set a birthdate" });
  await expect(gapRows).toHaveCount(1);

  // Dismissing on its owning widget still writes to the shared suppression bus.
  await settledClick(
    page,
    widget
      .getByTestId("data-quality-item")
      .filter({ hasText: "Set a birthdate" })
      .getByTestId("data-quality-dismiss")
  );
  await expect(gapRows).toHaveCount(0);

  await page.context().close();
});

test("hiding the Data quality widget hands its gaps back to the rollup (#1533)", async ({
  browser,
}) => {
  test.slow();
  resetDataQualityDismissals(DQ_GAPPY_PROFILE);
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DQ_GAPPY,
    password: E2E_MEMBER_PASSWORD,
  });
  const main = page.getByRole("main");
  await page.goto("/");

  // Hide the dedicated home from Customize (eye toggle → Save).
  await main.getByRole("button", { name: "Edit dashboard" }).click();
  await main.getByRole("button", { name: "Hide Data quality" }).click();
  await settledClick(
    page,
    main.getByRole("button", { name: "Save", exact: true })
  );
  await expect(main.getByTestId("data-quality")).toHaveCount(0);

  // The gaps fall back into the rollup (the catch-all) rather than losing their
  // dashboard reach entirely — hiding a card never silently drops a finding.
  await expect(
    main
      .getByTestId("coaching-observations-item")
      .filter({ hasText: "Set a birthdate" })
  ).toBeVisible();

  // Restore the default layout so neighboring specs see the seeded dashboard.
  await main.getByRole("button", { name: "Edit dashboard" }).click();
  await main.getByRole("button", { name: "Show Data quality" }).click();
  await settledClick(
    page,
    main.getByRole("button", { name: "Save", exact: true })
  );
  await expect(main.getByTestId("data-quality")).toBeVisible();

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
