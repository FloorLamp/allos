import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { hydratedClick, openMeasurementGroup } from "./helpers";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_WAIST,
  WAIST_LATEST_CM,
  WAIST_LOG_CM,
} from "./fixture-logins";

// Waist circumference as a BODY METRIC (#2322), in a browser.
//
// The owner's ruling is that this quantity is a metric, not a biomarker: measured
// with a tape at home, on the metric cadence, beside weight and body fat. Registry
// membership is what earns it a chart, a detail page, a ★ and the shared entry form —
// so those are what this spec checks, plus the one thing the ruling explicitly
// refuses:
//
//   • NO BAND. The published IDF/WHO cut-offs are sex- AND population-branched and
//     the vocabulary has no population axis, so METRIC_KNOWLEDGE declares an argued
//     `none`. A judgement card here would be one population's threshold applied to
//     everyone, which is the failure that declaration exists to prevent.
//   • THE TAPE ENTRY, through the same "Log measurements" form every other manual
//     metric uses — the affordance the whole ruling rests on.
//
// Fixture-OWNED (#868): a dedicated write profile whose seeded readings are its own.
// The logged reading lands on TODAY, a day the fixture deliberately leaves empty, and
// the manual sample writer upserts on its natural key — so --repeat-each stays clean.

test.describe("the waist-circ metric detail page (#2322)", () => {
  test("charts the tape readings and offers NO band", async ({ browser }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_WAIST,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.goto("/trends/metric/waist-circ");

    await expect(
      page.getByRole("heading", { level: 1, name: "Waist Circumference" })
    ).toBeVisible();
    await expect(page.getByTestId("metric-detail-chart")).toBeVisible();
    // The reading is in the table, in centimetres — the canonical unit for a length,
    // which is neither of the two branded kg/km units.
    await expect(
      page.getByTestId("metric-readings").getByText(`${WAIST_LATEST_CM} cm`)
    ).toBeVisible();

    // The refusal, made observable: no judgement card, ever. This is the assertion
    // that fails the day someone curates a single-population band for it.
    await expect(page.getByTestId("metric-judgment")).toHaveCount(0);

    // Registry membership earns the ★ like every other body metric.
    await expect(page.getByTestId("star-toggle")).toBeVisible();
  });

  test("logs a tape reading through the shared measurements form", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_WAIST,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.goto("/trends/metric/waist-circ");

    await hydratedClick(page, page.getByTestId("metric-measurement-toggle"));
    const form = page.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();

    // Metric-scoped: the modal carries this one field, not the whole morning log.
    await form
      .getByTestId("measurements-waist-circ")
      .fill(String(WAIST_LOG_CM));
    await form
      .getByRole("button", { name: "Save waist circumference" })
      .click();
    await expect(page.getByText("Waist Circumference saved")).toBeVisible();

    // It lands in the SAME store the seeded readings and the import projection use —
    // one series, whether the tape was read at home or printed by a clinic.
    await page.goto("/trends/metric/waist-circ");
    await expect(page.getByTestId("metric-latest-value")).toContainText(
      String(WAIST_LOG_CM)
    );
    await expect(
      page.getByTestId("metric-readings").getByText(`${WAIST_LOG_CM} cm`)
    ).toBeVisible();
  });

  test("the Body group of the combined form carries the field for an adult", async ({
    browser,
  }) => {
    // Height and head circumference are life-stage gated OFF for an adult; waist is
    // NOT — a tape measurement applies at every life stage, which is why it renders
    // beside weight rather than behind the growth gate.
    const page = await loginAs(browser, {
      username: E2E_LOGIN_WAIST,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.goto("/trends");

    await hydratedClick(page, page.getByTestId("log-measurements-toggle"));
    const form = page.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();
    await openMeasurementGroup(page, form, "body");
    await expect(form.getByTestId("measurements-waist-circ")).toBeVisible();
    await expect(form.locator("#m-height")).toHaveCount(0);
  });
});
