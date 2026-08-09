import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { loginAs } from "./nav";
import { followLink, settledClick } from "./helpers";
import {
  E2E_LOGIN_RISK_REVIEW,
  RISK_REVIEW_PROFILE,
  E2E_MEMBER_PASSWORD,
} from "./fixture-logins";
import { workerDbPath } from "./worker-env";

// Health risk factors on Medical → Background (issue #517). Runs authenticated as
// admin acting as the seeded profile 1 (shared storageState). Toggling a factor
// changes only the retest/screening cadence + ranking on Upcoming; it creates no
// new preventive items on its own, so this spec can't pollute the shared specs. It
// resets every factor to off at the end to leave the fixture as it found it.

// The five checkbox test ids, in form order.
const RISK_FACTOR_TESTIDS = [
  "risk-healthcare_worker",
  "risk-immunocompromised",
  "risk-dialysis",
  "risk-pregnant",
  "risk-noise_exposure",
] as const;

// Put the #2299 fixture profile back to "never reviewed, no factors". The review
// marker is DURABLE (a profile_settings row, not a time-boxed dismissal), so a
// second --repeat-each pass sharing this worker's DB would otherwise start from the
// state the first pass wrote and never see the gap at all. BLAST RADIUS: the `risk_%`
// keys and the `data-quality:` dismissals of the spec's OWN dedicated profile.
function resetRiskReviewProfile(): void {
  const handle = new Database(workerDbPath());
  try {
    handle.pragma("busy_timeout = 5000");
    const row = handle
      .prepare("SELECT id FROM profiles WHERE name = ?")
      .get(RISK_REVIEW_PROFILE) as { id: number } | undefined;
    if (!row) return;
    handle
      .prepare(
        `DELETE FROM profile_settings
          WHERE profile_id = ? AND key LIKE 'risk\\_%' ESCAPE '\\'`
      )
      .run(row.id);
    handle
      .prepare(
        `DELETE FROM upcoming_dismissals
          WHERE profile_id = ? AND signal_key LIKE 'data-quality:%'`
      )
      .run(row.id);
  } finally {
    handle.close();
  }
}

test.describe("health risk factors (issue #517)", () => {
  test("toggles a risk factor and persists it across reloads", async ({
    page,
  }) => {
    // Local `next dev` compiles the route on first hit.
    test.slow();

    await page.goto("/records/care/overview#risk-factors");

    const card = page.getByTestId("risk-factors");
    await expect(card).toBeVisible();
    // Privacy copy is stated; the disclaimer moved to /disclaimer (#1049).
    await expect(card).not.toContainText("not medical advice");
    await expect(card).toContainText("Privacy");

    const healthcare = page.getByTestId("risk-healthcare_worker");
    await expect(healthcare).not.toBeChecked();

    // Toggle on → autosaves.
    await healthcare.check();
    await expect(page.getByLabel("Saved").first()).toBeVisible(); // first-ok: asserts a Saved autosave indicator appears (several fields save) — order-agnostic

    // Reload — the flag round-trips from profile_settings.
    await page.reload();
    await expect(page.getByTestId("risk-healthcare_worker")).toBeChecked();

    // #553: the factor now ranks up the matching vaccine on the immunization page.
    // Profile 1's seeded influenza (last season's flu, ~13mo old) reads `due`; the
    // healthcare-worker factor elevates it with a calm reason line. Done here,
    // inside the single on→off window, so no other spec sees the mutated factor.
    await page.goto("/records/history/immunizations");
    const flu = page.getByTestId("immunization-prioritized-influenza");
    await expect(flu).toBeVisible();
    await expect(flu).toContainText("Healthcare worker");

    // Reset to off, leaving the shared fixture as we found it.
    await page.goto("/records/care/overview#risk-factors");
    await page.getByTestId("risk-healthcare_worker").uncheck();
    await expect(page.getByLabel("Saved").first()).toBeVisible(); // first-ok: asserts a Saved autosave indicator appears (several fields save) — order-agnostic
    await page.reload();
    await expect(page.getByTestId("risk-healthcare_worker")).not.toBeChecked();
  });
});

// THE REGRESSION GUARD for #2299. Before it, the "Review risk factors" data-quality
// gap cleared on a review MARKER whose only writer was a checkbox onChange — so for a
// profile to which none of the five factors apply (the majority case, and the one the
// card is loudest for) the "Fix it →" CTA landed on a form with no fix. The only
// escapes were checking a box and unchecking it again, or dismissing the card.
//
// The test above is exactly why that stayed invisible: the one spec that exercises
// this form toggles a factor as its own setup/teardown, so it always had something to
// press. This case presses NOTHING but the footer button, on its own dedicated
// profile, and follows the gap all the way from the dashboard back to gone.
test.describe("risk-factor review — the negative declaration (#2299)", () => {
  test("'None of these apply' clears the data-quality gap with no checkbox touched", async ({
    browser,
  }) => {
    // Local `next dev` compiles the dashboard + the care route on first hit.
    test.slow();
    resetRiskReviewProfile();

    const page = await loginAs(browser, {
      username: E2E_LOGIN_RISK_REVIEW,
      password: E2E_MEMBER_PASSWORD,
    });
    const main = page.getByRole("main");

    // The dashboard offers the gap, with its fix-it CTA.
    await page.goto("/");
    const widget = main.getByTestId("data-quality");
    const gapRow = widget
      .getByTestId("data-quality-item")
      .filter({ hasText: "Review risk factors" });
    await expect(gapRow).toBeVisible();

    // Follow it — this is the CTA (#1146) that used to land on a form with no fix.
    await followLink(
      page,
      gapRow.getByRole("link"),
      /\/records\/care\/overview/
    );
    const card = page.getByTestId("risk-factors");
    await expect(card).toBeVisible();
    // Nothing is checked, and the form makes no claim to have been reviewed…
    for (const id of RISK_FACTOR_TESTIDS) {
      await expect(card.getByTestId(id)).not.toBeChecked();
    }
    await expect(card.getByTestId("risk-reviewed")).toHaveCount(0);

    // …so the footer offers the declaration. Press it WITHOUT touching a checkbox.
    await settledClick(page, card.getByTestId("risk-none-apply"));

    // The answer is now stated on the surface that owns it, and the button is gone
    // (nothing left to declare).
    await expect(card.getByTestId("risk-reviewed")).toContainText("Reviewed");
    await expect(card.getByTestId("risk-none-apply")).toHaveCount(0);

    // It round-trips, and it wrote NO flag: declaring the negative is not a value.
    await page.reload();
    const reloaded = page.getByTestId("risk-factors");
    await expect(reloaded.getByTestId("risk-reviewed")).toBeVisible();
    await expect(reloaded.getByTestId("risk-none-apply")).toHaveCount(0);
    for (const id of RISK_FACTOR_TESTIDS) {
      await expect(reloaded.getByTestId(id)).not.toBeChecked();
    }

    // And the gap is gone from the dashboard. It was this profile's ONLY structural
    // gap, so the widget self-hides entirely (the absent-pillar rule).
    await page.goto("/");
    await expect(
      main
        .getByTestId("data-quality-item")
        .filter({ hasText: "Review risk factors" })
    ).toHaveCount(0);
    await expect(main.getByTestId("data-quality")).toHaveCount(0);

    await page.context().close();
  });
});
