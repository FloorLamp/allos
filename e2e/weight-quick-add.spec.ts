import { test, expect } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_WEIGHT_QA,
  WEIGHT_QUICKADD_PROFILE,
} from "./fixture-logins";

// Dashboard weight quick-add (#1042 phase 2): the weight-trend widget's inline
// form posts the SAME addBodyMetric write core as the Trends → Body quick-add,
// so a weigh-in logged from the dashboard persists (survives a reload) and joins
// the same deduped daily series the widget charts.
//
// SETTLE DISCIPLINE: the dashboard carries steady background action-POST traffic,
// so settledClick's any-POST wait can resolve on a bystander request (see
// e2e/helpers.ts). The widget instead renders a SERVER-truth marker
// (`weight-server-latest`, built from the server-resolved series) that updates
// only once the write committed and the refresh round-tripped — every mutation
// here settles on that marker (the wellbeing card's mood-server-logged
// precedent).
//
// Fixture hygiene (#868): the dedicated Weight Quickadd profile carries two
// seeded weigh-ins (notes 'e2e:seed-weight'); this spec OWNS every other
// body_metrics row on it and clears them at test start (the smoke.spec direct-DB
// precedent), so --repeat-each starts from the same two-point series every run.

function resetQuickAddRows(): void {
  const dbPath =
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db");
  const db = new Database(dbPath);
  try {
    db.pragma("busy_timeout = 5000");
    db.prepare(
      `DELETE FROM body_metrics
        WHERE profile_id = (SELECT id FROM profiles WHERE name = ?)
          AND (notes IS NULL OR notes != 'e2e:seed-weight')`
    ).run(WEIGHT_QUICKADD_PROFILE);
  } finally {
    db.close();
  }
}

test("dashboard weight quick-add logs a weigh-in that persists into the trend (#1042)", async ({
  browser,
}) => {
  resetQuickAddRows();
  const page = await loginAs(browser, {
    username: E2E_LOGIN_WEIGHT_QA,
    password: E2E_MEMBER_PASSWORD,
  });
  try {
    await page.goto("/");
    // Two seeded points → the chart state, with the newest seed as the server
    // latest (70.6 kg, the login's default display unit).
    const marker = page.getByTestId("weight-server-latest");
    await expect(marker).toHaveAttribute("data-value", "70.6");

    // Log today's weight. toPass retries the submit through the hydration
    // window — a pre-hydration click is swallowed, and no single expect can
    // both re-click and await the server marker. A duplicate submit is
    // value-idempotent here: same-day same-source rows AVERAGE in the daily
    // series (getBodyMetricDailySeries), and averaging equal values changes
    // nothing.
    const input = page.getByTestId("weight-quick-add-input");
    await expect(input).toBeVisible();
    await expect(async () => {
      await input.fill("71.4");
      await page.getByTestId("weight-quick-add-save").click({ timeout: 2_000 });
      await expect(marker).toHaveAttribute("data-value", "71.4", {
        timeout: 4_000,
      });
    }).toPass({ timeout: 20_000, intervals: [300, 700, 1500] });

    // Server truth survives a reload — the weigh-in persisted and is the trend's
    // newest point, rendered by the chart-state widget.
    await page.reload();
    await expect(marker).toHaveAttribute("data-value", "71.4");
    await expect(
      page.getByRole("heading", { name: "Weight trend" })
    ).toBeVisible();

    // And it appears in the same series on Trends → Body (the widget's link
    // target) — the one-computation check across both surfaces.
    await page.goto("/trends?tab=body");
    // Scope to the classic chart stack (the desktop-default layout): the #1067
    // Phase 2 tile grid renders FIRST in the DOM but is md:hidden at this
    // viewport, so an unscoped .first() would match an invisible tile value.
    await expect(
      page
        .getByTestId("body-charts-all")
        .getByText("71.4", { exact: false })
        .first()
    ).toBeVisible();
  } finally {
    await page.context().close();
  }
});
