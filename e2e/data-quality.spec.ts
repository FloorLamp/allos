import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
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

// Structural data-quality gaps (issue #1045). One pure gap model, many formatters: a
// dedicated dashboard widget (top-3 by leverage, no score — a count and a list), the
// coaching rollup (a dismiss there or here silences everywhere through the shared bus),
// and a household per-member gaps line. The seeded fixtures (seed-events.ts) ship a
// GAPPY sole profile (no birthdate/sex + a failed doc), a COMPLETE profile (widget
// self-hides), and a caregiver with a gappy child.

// Clears the gappy profile's data-quality dismissals so the widget is guaranteed
// populated before each assertion, regardless of retries or a prior dismiss test
// (the resetCoachingObservationDismissals pattern from #206/#449). BLAST RADIUS: only
// the `data-quality:` namespace on the gappy fixture profile.
function resetDataQualityDismissals(profileName: string): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
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

test("dismissing a gap silences it on BOTH the widget and the coaching rollup (#1045)", async ({
  browser,
}) => {
  resetDataQualityDismissals(DQ_GAPPY_PROFILE);
  const page = await loginAs(browser, {
    username: E2E_LOGIN_DQ_GAPPY,
    password: E2E_MEMBER_PASSWORD,
  });
  await page.goto("/");

  const main = page.getByRole("main");
  const widget = main.getByTestId("data-quality");
  const rollup = main.getByTestId("coaching-observations");
  await expect(widget).toBeVisible();
  await expect(rollup).toBeVisible();

  // The birthdate gap shows on BOTH surfaces (data-quality joins collectCoachingFindings).
  await expect(
    widget
      .getByTestId("data-quality-item")
      .filter({ hasText: "Set a birthdate" })
  ).toBeVisible();
  await expect(
    rollup
      .getByTestId("coaching-observations-item")
      .filter({ hasText: "Set a birthdate" })
  ).toBeVisible();

  // Dismiss it on the data-quality widget (the shared suppression bus).
  await settledClick(
    page,
    widget
      .getByTestId("data-quality-item")
      .filter({ hasText: "Set a birthdate" })
      .getByTestId("data-quality-dismiss")
  );

  // Gone from BOTH surfaces after the re-render — dismiss once, silence everywhere.
  await expect(
    widget
      .getByTestId("data-quality-item")
      .filter({ hasText: "Set a birthdate" })
  ).toHaveCount(0);
  await expect(
    rollup
      .getByTestId("coaching-observations-item")
      .filter({ hasText: "Set a birthdate" })
  ).toHaveCount(0);

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
