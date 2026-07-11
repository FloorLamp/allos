import { test, expect } from "@playwright/test";

// Dogfoods the Oura Ring integration config surface (issue #140). The connect flow
// validates the pasted token with a live Oura whoami call on submit, which we can't
// exercise offline in CI, so this spec asserts the RENDERED connect form + setup
// steps and that Oura appears as a connectable provider in the Import grid — the
// idempotent sync mapping/dedup is covered by the pure + db tiers instead.
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

  test("Oura shows as a connectable provider in the Import grid", async ({
    page,
  }) => {
    await page.goto("/data?section=import");
    const main = page.getByRole("main");

    // The provider card (from the declarative registry) links to its setup page.
    const card = main.getByRole("link", { name: /Oura Ring/ });
    await expect(card).toBeVisible();
    await expect(card).toHaveAttribute("href", "/integrations/oura");
  });
});
