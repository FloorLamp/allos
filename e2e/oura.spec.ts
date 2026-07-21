import { test, expect } from "@playwright/test";

// Dogfoods the Oura Ring integration config surface (issue #140). The connect flow
// validates the pasted token with a live Oura whoami call on submit, which we can't
// exercise offline in CI, so this spec asserts the RENDERED connect form + setup
// steps — the idempotent sync mapping/dedup is covered by the pure + db tiers
// instead. (Oura's grid-presence assertion moved into the registry-driven
// e2e/integrations-grid.spec.ts, which covers every available provider in one pass.)
test.describe("Oura Ring integration", () => {
  test("the setup page renders the paste-token connect form", async ({
    page,
  }) => {
    await page.goto("/integrations/oura");
    const main = page.getByRole("main");

    await expect(
      main.getByRole("heading", { name: "Oura Ring", exact: true })
    ).toBeVisible();

    // The token paste field + connect button (no OAuth redirect for a token kind).
    await expect(main.getByTestId("oura-token-input")).toBeVisible();
    await expect(main.getByTestId("oura-connect")).toBeVisible();

    // The setup card explains the personal-access-token flow.
    // Exact match — the phrase also appears inside the provider blurb, so a
    // substring match strict-mode-fails on two nodes.
    await expect(
      main.getByText("create a personal access token", { exact: true })
    ).toBeVisible();
  });
});
