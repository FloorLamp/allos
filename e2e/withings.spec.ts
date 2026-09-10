import { test, expect } from "./fixtures";
// Dogfoods the Withings integration config surface (issue #142). The connect flow is
// a real OAuth redirect to Withings that we can't exercise offline in CI, so this
// spec asserts the RENDERED credentials form + setup steps and the credentials→
// Connect reveal — the idempotent sync mapping/dedup and BP-as-vitals behavior are
// covered by the pure + db tiers instead. (Withings' grid-presence assertion moved
// into the registry-driven e2e/integrations-grid.spec.ts, which covers every
// available provider in one pass.)
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

    // ONE COMMIT PER CARD (#4978 ruling 6): both submits now sit on this card, and
    // Connect is the action it exists for, so the credentials form drops to the
    // maintenance edit it has become. Counted whole rather than per control — a
    // per-control check cannot see a second fill arriving beside the one it
    // checks. Only the WITH-credentials state is asserted: the empty card's fill
    // cannot be re-observed on a shared DB, because nothing in this UI unsaves a
    // credential (#868 fixture ownership).
    await expect(
      main.locator(".button-control-primary, .button-control-danger")
    ).toHaveText(["Connect with Withings"]);
  });
});
