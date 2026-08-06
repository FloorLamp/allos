import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { hydratedClick } from "./helpers";
import {
  E2E_MEMBER_PASSWORD,
  E2E_LOGIN_PEAK_FLOW,
  E2E_LOGIN_PEAK_FLOW_LOG,
  PEAK_FLOW_LATEST_LMIN,
  PEAK_FLOW_LOG_BEST_LMIN,
  PEAK_FLOW_LOG_BLOW_LMIN,
} from "./fixture-logins";

// Respiratory function on the biomarker substrate (#1850) — the rendered half.
//
// The domain's one divergence from its three specialty siblings is that its band is
// SELF-REFERENTIAL: an asthma action plan reads a blow as a percentage of your own
// personal best, not against a population range. So the two states that matter in a
// browser are the two this file covers:
//
//   • NOTHING TO JUDGE AGAINST. A profile with readings and no declared personal
//     best gets NO verdict — stated plainly, never a borrowed range. That is the
//     safety property, and it rides a dedicated read-only fixture so --repeat-each
//     cannot fill the gap in and quietly stop testing it.
//   • THE VERDICT, once the best is declared. Logged through the same measurements
//     quick-add every other vital uses, then banded against the best typed into the
//     card that shows it.

test.describe("with no personal best there is no verdict (#1850)", () => {
  test("the zone card says so instead of borrowing a population band", async ({
    browser,
  }) => {
    const page = await loginAs(browser, {
      username: E2E_LOGIN_PEAK_FLOW,
      password: E2E_MEMBER_PASSWORD,
    });
    await page.goto("/trends/metric/peak-flow");

    const zone = page.getByTestId("peak-flow-zone");
    await expect(zone).toBeVisible();
    // No verdict at all — not a green one, not a red one.
    await expect(zone).toHaveAttribute("data-zone", "none");
    await expect(page.getByTestId("peak-flow-zone-none")).toBeVisible();
    await expect(page.getByTestId("peak-flow-zone-label")).toHaveCount(0);

    // …and NO band card either: peak flow's canonical entry curates none, so the
    // shared judgement card must stay away rather than render an empty range.
    await expect(page.getByTestId("metric-judgment")).toHaveCount(0);

    // The readings themselves are still fully present — the fix is what the page
    // CLAIMS, never what it hides.
    await expect(page.getByTestId("metric-latest-value")).toContainText(
      String(PEAK_FLOW_LATEST_LMIN)
    );
    await expect(
      page
        .getByTestId("metric-readings")
        .getByText(`${PEAK_FLOW_LATEST_LMIN} L/min`)
    ).toBeVisible();

    // The suggestion is offered, and it is only a suggestion: the field is still
    // empty and the zone is still absent.
    await expect(
      page.getByTestId("peak-flow-personal-best-hint")
    ).toBeVisible();
    await expect(page.getByTestId("peak-flow-personal-best")).toHaveValue("");
  });
});

test.describe("logging a blow and reading its zone (#1850)", () => {
  test("the measurements quick-add writes it, and the declared best bands it", async ({
    browser,
  }) => {
    // A dedicated profile with NO peak-flow readings, so this blow is the only one
    // on file and the resulting percentage is exact rather than an average.
    const page = await loginAs(browser, {
      username: E2E_LOGIN_PEAK_FLOW_LOG,
      password: E2E_MEMBER_PASSWORD,
    });
    // Log through the SAME combined form every other vital uses — no new one-tap
    // affordance class for this domain, which is why no #2130 census row is needed.
    await page.goto("/trends/metric/peak-flow");
    await hydratedClick(page, page.getByTestId("metric-measurement-toggle"));
    const form = page.getByTestId("measurements-quick-add");
    await expect(form).toBeVisible();

    // Metric-scoped: the modal carries this one field, not the whole morning log.
    await page
      .getByTestId("measurements-peak-flow")
      .fill(String(PEAK_FLOW_LOG_BLOW_LMIN));
    // The clock time is what makes a second blow on one flare day a second reading
    // rather than a correction of the first.
    await page.getByTestId("measurements-peak-flow-time").fill("07:15");
    // The metric-scoped form names the one measure it takes, in its button and in
    // its toast.
    await form
      .getByRole("button", { name: "Save peak expiratory flow" })
      .click();
    await expect(page.getByText("Peak Expiratory Flow saved")).toBeVisible();

    // The blow is listed under the chart it shapes, in the metric's own unit —
    // proof it landed in the stream this surface reads, not in a store of its own.
    await page.goto("/trends/metric/peak-flow");
    await expect(
      page
        .getByTestId("metric-readings")
        .getByText(`${PEAK_FLOW_LOG_BLOW_LMIN} L/min`)
    ).toBeVisible();

    // Declare the personal best on the card that reads it — a profile health fact,
    // autosaved on blur like every other settings-shaped field.
    const bestField = page.getByTestId("peak-flow-personal-best");
    await expect(bestField).toBeVisible();
    await bestField.fill(String(PEAK_FLOW_LOG_BEST_LMIN));
    await bestField.blur();

    // 480 of a 600 best is 80% — the green FLOOR, the edge worth pinning in a
    // browser because it is the one a reader would most easily get wrong. The save
    // revalidates this page, so the verdict arrives without a reload.
    const zone = page.getByTestId("peak-flow-zone");
    await expect(zone).toHaveAttribute("data-zone", "green");
    await expect(page.getByTestId("peak-flow-zone-percent")).toContainText(
      "80%"
    );
    await expect(page.getByTestId("peak-flow-zone-percent")).toContainText(
      `${PEAK_FLOW_LOG_BEST_LMIN} L/min`
    );
  });
});
