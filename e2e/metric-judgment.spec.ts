import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_METRIC_JUDGMENT,
  E2E_LOGIN_TRENDS_BODY,
  METRIC_JUDGMENT_CLINIC_BPM,
} from "./fixture-logins";

// One judgement per identity, on the surface that charts the trend (#1996), and
// the completeness fold that comes with it (#1997 phase 1).
//
// WHAT WAS WRONG. `/trends/metric/resting-hr` charts `body_metrics.resting_hr`.
// The bands that interpret a resting heart rate — including the pediatric ones —
// are filed in the canonical vocabulary under a biomarker NAME. Nothing mapped one
// to the other, so a two-year-old's steady 120 bpm rendered as an unannotated
// line: true, and unjudged, when the very band that says it is normal (1–3 →
// 80–150) already existed. And a clinic-measured reading of the same quantity sat
// in `medical_records`, invisible to that chart.
//
// Fixtures (#868): a dedicated CHILD profile whose readings arrive only as a
// wearable stream plus one clinical record, and the shared adult Trends-Body
// profile for the contrast. Both specs navigate only — no writes.

test.describe("the band a streamed trend is read against (#1996)", () => {
  test("a child's streamed resting HR is judged by its age band, and the clinic reading joins the trend", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_METRIC_JUDGMENT,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.goto("/trends/metric/resting-hr");

    const judgment = page.getByTestId("metric-judgment");
    await expect(judgment).toBeVisible();
    // The pediatric band, named — an adult range silently applied to a child is
    // the #150 failure this generalizes.
    await expect(judgment).toContainText("age 1–3");
    await expect(page.getByTestId("metric-judgment-reference")).toHaveText(
      "80–150 bpm"
    );
    // 120 bpm is normal for a toddler; the adult 50–100 would have called it high.
    await expect(page.getByTestId("metric-judgment-badge")).not.toHaveText(
      "Above range"
    );

    // The completeness half: the clinic-measured reading is listed with the
    // wearable ones, and says where it actually lives.
    const readings = page.getByTestId("metric-readings");
    await expect(
      readings.getByText(`${METRIC_JUDGMENT_CLINIC_BPM} bpm`)
    ).toBeVisible();
    await expect(page.getByTestId("metric-reading-observed")).toBeVisible();
  });

  test("an adult profile is judged by the adult range on the same page", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_TRENDS_BODY,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.goto("/trends/metric/resting-hr");

    const judgment = page.getByTestId("metric-judgment");
    await expect(judgment).toBeVisible();
    await expect(page.getByTestId("metric-judgment-reference")).toHaveText(
      "50–100 bpm"
    );
    // No age band applied, so none is claimed.
    await expect(judgment).not.toContainText("age ");
  });
});
