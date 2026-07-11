import { test, expect } from "@playwright/test";

// Dogfoods the Withings integration config surface (issue #142). The connect flow is
// a real OAuth redirect to Withings that we can't exercise offline in CI, so this
// spec asserts the RENDERED credentials form + setup steps and that Withings appears
// as a connectable provider in the Import grid — the idempotent sync mapping/dedup
// and BP-as-vitals behavior are covered by the pure + db tiers instead.
test.describe("Withings integration", () => {
  test("the setup page renders the OAuth credentials form + callback URI", async ({
    page,
  }) => {
    await page.goto("/integrations/withings");
    const main = page.getByRole("main");

    await expect(
      main.getByRole("heading", { name: "Withings", exact: true })
    ).toBeVisible();

    // The app-credentials form (client id/secret) that starts the OAuth flow.
    await expect(main.getByTestId("withings-client-id")).toBeVisible();
    await expect(main.getByTestId("withings-client-secret")).toBeVisible();
    await expect(main.getByTestId("withings-save")).toBeVisible();

    // The setup card explains registering a developer app + callback URI.
    await expect(
      main.getByText("Withings developer dashboard", { exact: true })
    ).toBeVisible();
  });

  test("saving credentials reveals the Connect with Withings button", async ({
    page,
  }) => {
    await page.goto("/integrations/withings");
    const main = page.getByRole("main");

    await main.getByTestId("withings-client-id").fill("test-client-id");
    await main.getByTestId("withings-client-secret").fill("test-client-secret");
    await main.getByTestId("withings-save").click();

    // Credentials saved → the OAuth connect button appears (no redirect triggered).
    await expect(main.getByTestId("withings-connect")).toBeVisible();
  });

  test("Withings shows as a connectable provider in the Import grid", async ({
    page,
  }) => {
    await page.goto("/data?section=import");
    const main = page.getByRole("main");

    const card = main.getByRole("link", { name: /Withings/ });
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("href", "/integrations/withings");
  });
});
