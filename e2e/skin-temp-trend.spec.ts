import { test, expect } from "./fixtures";
import { loginAs } from "./nav";
import { E2E_LOGIN_SKIN_TEMP, E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Skin temperature variation on Trends → Body. Health Connect delivers ONE nightly
// reading as a SIGNED delta from the tracker's own rolling baseline — not an absolute
// temperature — so it lands in metric_samples ('skin_temp_delta_c') rather than the
// reference-range-flagged "Body Temperature" vital, where a 0.6 against a 97–99 °F
// envelope would read as catastrophically abnormal.
//
// The E2E_LOGIN_SKIN_TEMP fixture profile carries five nightly deltas straddling zero,
// so this proves the card renders AND that the negative nights survive (a `min: 0`
// bound would have dropped them). Spec-owned fixture; reads only.
test.describe("Skin temperature variation trend", () => {
  test("renders the card for a profile with nightly deltas", async ({
    browser,
  }) => {
    test.slow(); // local `next dev` compiles the Trends route on first hit

    const member = await loginAs(browser, {
      username: E2E_LOGIN_SKIN_TEMP,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      await member.goto("/trends?tab=body&view=all");
      await expect(member.getByRole("tab", { name: "Body" })).toHaveAttribute(
        "aria-selected",
        "true"
      );

      const card = member.getByTestId("vitals-skin-temp");
      await expect(card).toBeVisible();
      await expect(card.getByTestId("chart-card-header-link")).toHaveAttribute(
        "href",
        "/trends/metric/skin-temp"
      );
      await expect(
        card.getByRole("heading", { name: "Skin temperature variation" })
      ).toBeVisible();
      // The card must explain that the number is a deviation, not a temperature —
      // a bare "0.6 °C" reads as a fever value without it.
      await expect(card).toContainText("baseline");

      // #1486 made tiles and charts two renderings of ONE metric set, and tiles are
      // the DEFAULT on mobile — so a metric registered only as a chart would be
      // invisible on a phone. Assert the tile too, or the responsive pair can drift.
      await member.setViewportSize({ width: 390, height: 844 });
      await member.goto("/trends?tab=body&view=tiles");
      const tile = member.getByTestId("body-tile-skin-temp");
      await expect(tile).toBeVisible();
      await expect(tile.getByText("Skin Temp", { exact: true })).toBeVisible();
    } finally {
      await member.context().close();
    }
  });

  test("is hidden for a profile with no skin-temperature readings", async ({
    page,
  }) => {
    test.slow();

    // The default seeded profile has vitals but no skin_temp_delta_c samples — no
    // other fixture writes that metric — so the card is data-gated off while the rest
    // of the Body tab still renders.
    await page.goto("/trends?tab=body&view=all");
    await expect(page.getByRole("tab", { name: "Body" })).toBeVisible();
    await expect(
      page.getByRole("main").getByTestId("vitals-skin-temp")
    ).toHaveCount(0);
  });
});
