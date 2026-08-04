import { test, expect } from "./fixtures";
import { followLink } from "./helpers";
import { loginAs } from "./nav";
import { E2E_LOGIN_VITALS_DAY, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// One renderer per cadence (#1932). A vital sign is stored with `category = 'vitals'`
// and was rendered through the LAB detail page anyway — a permanently-empty "Lab
// reference" column, a duplicate optimal range, and a whole-history spline drawn
// across years where nothing was measured. The discriminator existed in the data and
// nothing in the presentation consumed it.
//
// This spec pins the routing from the browser's side: a continuous vital opens on the
// metric detail surface (windowed chart, rolling summary, readings table), the lab
// renderer never draws one, and the panel cross-reference still crosses — while an
// EPISODIC reading that also carries `category = 'vitals'` (a functional-fitness
// marker, an audiogram threshold) keeps the reference-range page, because the rule is
// cadence and not category.
//
// Fixture (#868 hygiene): the dedicated read-only E2E_LOGIN_VITALS_DAY profile, whose
// vitals (SpO2, blood pressure, respiratory rate, body temperature) live nowhere else,
// so --repeat-each and a neighbour's writes can't move them. Navigation only.

async function vitalsDayPage(browser: Parameters<typeof loginAs>[0]) {
  return loginAs(browser, {
    username: E2E_LOGIN_VITALS_DAY,
    password: E2E_MEMBER_PASSWORD,
  });
}

test.describe("a vital renders on its own cadence's surface (#1932)", () => {
  test("the biomarkers list opens a vital on the metric detail surface", async ({
    browser,
  }) => {
    const page = await vitalsDayPage(browser);
    await page.goto("/results/biomarkers");

    // The reading is listed in the catalog exactly as before — what changed is
    // where its name goes.
    const row = page.getByRole("link", { name: "Oxygen Saturation" });
    await followLink(page, row, /\/trends\/metric\/spo2/);

    await expect(page.getByTestId("metric-detail-page")).toBeVisible();
    // The two things the lab page could not give a daily reading: a windowed chart
    // and the trailing 7/30/90-day summary (#1909).
    await expect(page.getByTestId("metric-detail-chart")).toBeVisible();
    await expect(page.getByTestId("metric-period-stats")).toBeVisible();
    // …and the readings themselves, one tap from the chart they shape.
    await expect(page.getByTestId("metric-readings-table")).toBeVisible();
  });

  test("a stale biomarker URL for a vital lands on that surface, and the lab renderer never draws one", async ({
    browser,
  }) => {
    const page = await vitalsDayPage(browser);
    // What a bookmark or a shared link from before #1932 looks like.
    await page.goto("/biomarkers/view?name=Oxygen%20Saturation");
    await page.waitForURL(/\/trends\/metric\/spo2/);

    await expect(page.getByTestId("metric-detail-page")).toBeVisible();
    // The tripwire: none of the lab page's furniture may appear for a vital. A
    // vital has no lab-issued reference range and no reporting lab, so these
    // columns could never populate — that is why they are gone rather than empty.
    await expect(
      page.getByRole("columnheader", { name: "Lab reference" })
    ).toHaveCount(0);
    await expect(
      page.getByRole("columnheader", { name: "Reported as" })
    ).toHaveCount(0);
    await expect(
      page.getByRole("link", { name: "Back to biomarkers" })
    ).toHaveCount(0);
  });

  test("the panel cross-reference stays, and each sibling opens on its own surface", async ({
    browser,
  }) => {
    const page = await vitalsDayPage(browser);
    await page.goto("/trends/metric/spo2");

    const panel = page.getByTestId("panel-siblings");
    await expect(panel).toContainText("Vital signs");
    // The card is the one thing the lab page did right here — the reading arrived
    // with a blood pressure, and saying so is genuinely useful. The chip resolves
    // through the same helper, so it lands on the sibling's OWN surface.
    await followLink(
      page,
      panel.getByRole("link", { name: "Blood Pressure Systolic" }),
      /\/trends\/metric\/systolic/
    );
    await expect(page.getByTestId("metric-detail-page")).toBeVisible();
  });

  test("an episodic reading keeps the reference-range page, category='vitals' or not", async ({
    browser,
  }) => {
    const page = await vitalsDayPage(browser);
    // Grip strength is `category = 'vitals'` too, and belongs on the lab renderer:
    // it is an annual physical test read by an age/sex percentile, not a stream. If
    // the rule ever collapses back into a category check, this redirects and fails.
    await page.goto("/biomarkers/view?name=Grip%20Strength");

    await expect(page).toHaveURL(/\/biomarkers\/view/);
    await expect(
      page.getByRole("link", { name: "Back to biomarkers" })
    ).toBeVisible();
  });
});
