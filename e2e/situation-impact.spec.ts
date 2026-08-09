import Database from "better-sqlite3";
import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { settledClick } from "./helpers";
import { workerDbPath } from "./worker-env";
import {
  E2E_LOGIN_PAIRED_OBS,
  E2E_LOGIN_SITIMPACT,
  E2E_MEMBER_PASSWORD,
  PAIRED_OBS_PROFILE,
} from "./fixture-logins";

// Situation-window analytics (#1297): the pooled protocol-compare engine pointed at the
// declared situation transition log renders a per-situation "Situation impact" card on
// Trends → Insights. Driven against the dedicated SITUATION_IMPACT_PROFILE, seeded with a
// past Travel window (with during + baseline weight/resting-HR readings) and a one-day
// High-stress toggle that has too little history to render (the absent-pillar rule).

test.describe("Situation impact cards (#1297)", () => {
  test("a seeded Travel window renders a pooled impact card; a thin situation renders nothing", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_SITIMPACT,
      password: E2E_MEMBER_PASSWORD,
    });

    await page.goto("/trends?tab=insights");

    const impacts = page.getByTestId("situation-impacts");
    await expect(impacts).toBeVisible();

    // Travel has a real window with enough data → its card renders, tagged with the window
    // + day count and the pooled outcome chips (weight + resting HR).
    const travel = page.getByTestId("situation-impact-Travel");
    await expect(travel).toBeVisible();
    await expect(travel).toContainText("Travel");
    await expect(travel).toContainText(/window/);
    await expect(
      travel.getByTestId("situation-impact-Travel-metric:weight")
    ).toBeVisible();
    await expect(
      travel.getByTestId("situation-impact-Travel-metric:resting_hr")
    ).toBeVisible();
    // The pooled resting-HR shift (baseline 50 → during 56) reads +6.
    await expect(
      travel.getByTestId("situation-impact-Travel-metric:resting_hr")
    ).toContainText("+6");

    // High stress toggled for a single day → below the during-days floor → no card at all.
    await expect(page.getByTestId("situation-impact-High stress")).toHaveCount(
      0
    );
  });
});

// Paired observations (#2177): the declared factor × outcome registry renders its
// findings on the SAME Trends → Insights tab. Driven against the dedicated
// PAIRED_OBS_PROFILE, seeded with #2177's own fixture — 21 evenings with a drink
// logged and 9 without, overnight HRV on the mornings after — so the card states both
// arms with both n, and a dismiss silences it.
test.describe("Paired observations (#2177)", () => {
  // The dismissal is month-anchored, so it persists across retries and --repeat-each
  // once the dismiss test has run. Clear the namespace for THIS profile only.
  function resetPairedDismissals(): void {
    const db = new Database(workerDbPath());
    try {
      db.pragma("busy_timeout = 5000");
      const row = db
        .prepare("SELECT id FROM profiles WHERE name = ?")
        .get(PAIRED_OBS_PROFILE) as { id: number } | undefined;
      if (row)
        db.prepare(
          `DELETE FROM upcoming_dismissals
            WHERE profile_id = ? AND signal_key LIKE 'paired-obs:%'`
        ).run(row.id);
    } finally {
      db.close();
    }
  }

  test("the alcohol↔HRV pair states both arms with both n, and dismisses", async ({
    browser,
  }) => {
    resetPairedDismissals();
    const page = await loginAs(browser, {
      username: E2E_LOGIN_PAIRED_OBS,
      password: E2E_MEMBER_PASSWORD,
    });

    await page.goto("/trends?tab=insights");

    const paired = page.getByTestId("paired-observations");
    await expect(paired).toBeVisible();
    await expect(paired).toContainText("Overnight HRV and evenings with a drink");
    await settledClick(page, page.getByTestId("paired-observations-toggle"));
    // Both arms' n and both means — an observation that hides its sample size is
    // exactly what the copy contract forbids.
    await expect(paired).toContainText("21 nights");
    await expect(paired).toContainText("9 nights");
    await expect(paired).toContainText("42 ms");
    await expect(paired).toContainText("54 ms");
    // Co-occurrence, never causation.
    await expect(paired).toContainText("not the same as one moving the other");

    // Coaching tier: calm and hideable, and NEVER an attention item. The
    // non-hideable "Needs attention" hero must never carry it — reach without noise.
    await page.goto("/");
    const hero = page.getByRole("main").getByTestId("needs-attention");
    if (await hero.count())
      await expect(hero).not.toContainText("Overnight HRV");

    // A dismiss silences it through the shared bus.
    await page.goto("/trends?tab=insights");
    await settledClick(page, page.getByTestId("paired-observations-toggle"));
    await settledClick(page, page.getByTestId("paired-observations-dismiss"));
    await expect(page.getByTestId("paired-observations")).toHaveCount(0);

    resetPairedDismissals();
  });
});
