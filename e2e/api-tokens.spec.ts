import { test, expect } from "./fixtures";
import { hydratedClick, settledFill } from "./helpers";

// API tokens on Settings → Account & security → API tokens (#1734).
//
// The one rendered surface the token foundation adds, and the one behaviour that
// cannot be proven anywhere else: the secret is shown EXACTLY ONCE. The instance
// stores only a scrypt hash, so there is no "show it again" affordance to fall back
// on — if the mint panel didn't render the value, or a reload could bring it back,
// the credential would be either unusable or recoverable, and both are bugs.
//
// FIXTURE OWNERSHIP: every test mints tokens under its own unique name and revokes
// them at the end, so it never counts or disturbs rows another spec owns.
test.describe("API tokens (#1734)", () => {
  test("the tokens page is reachable from the Account & security group nav", async ({
    page,
  }) => {
    test.slow();
    await page.goto("/settings/account");
    // The sub-page strip comes from the settings registry, so this also proves the
    // registry entry reaches the rendered nav (not just the route).
    const nav = page.getByTestId("settings-subpage-nav");
    await expect(nav).toBeVisible();
    await nav.getByRole("link", { name: "API tokens" }).click();
    await expect(page).toHaveURL(/\/settings\/tokens$/);
    await expect(page.getByTestId("api-token-mint")).toBeVisible();
  });

  test("create → secret shown once → listed → revoke → gone", async ({
    page,
  }) => {
    test.slow();
    const name = `spec token ${Date.now()}`; // clock-ok: a uniqueness suffix for this spec's own fixture row, never a stored timestamp — the token's created_at is stamped by the server
    await page.goto("/settings/tokens");

    await settledFill(page, page.getByTestId("api-token-name"), name);
    await hydratedClick(page, page.getByTestId("api-token-create"));

    // 1. The secret panel renders, and it carries a real `<id>.<secret>` value.
    const panel = page.getByTestId("api-token-secret");
    await expect(panel).toBeVisible();
    const shown = (await panel.locator("code").innerText()).trim();
    expect(shown).toMatch(/^[1-9][0-9]*\.[A-Za-z0-9_-]+$/);
    // The warning is the whole contract with the user — it must actually say so.
    await expect(panel).toContainText("only time it is shown");

    // 2. The token is in the list, with the capability and a never-used stamp.
    const row = page
      .getByTestId("api-token-row")
      .filter({ hasText: name })
      .first(); // first-ok: the name is unique to this test, so this is spec-owned data
    await expect(row).toBeVisible();
    await expect(row.getByTestId("api-token-scope")).toHaveText(
      "Upload documents"
    );
    await expect(row.getByTestId("api-token-last-used")).toHaveText("never");

    // 3. ONCE means once: dismissing the panel and reloading must not bring the
    //    secret back anywhere on the page — the server no longer has it.
    await hydratedClick(page, page.getByTestId("api-token-secret-dismiss"));
    await expect(panel).toBeHidden();
    await page.reload();
    await expect(page.getByTestId("api-token-secret")).toHaveCount(0);
    expect(await page.content()).not.toContain(shown.split(".")[1]);

    // 4. Revoke removes it from the list.
    const survivor = page
      .getByTestId("api-token-row")
      .filter({ hasText: name })
      .first(); // first-ok: spec-owned row, matched by its unique name
    await hydratedClick(page, survivor.getByTestId("api-token-revoke"));
    await expect(page.getByTestId("api-token-status")).toHaveText(
      "Token revoked."
    );
    await expect(
      page.getByTestId("api-token-row").filter({ hasText: name })
    ).toHaveCount(0);

    // …and it stays gone across a reload (the revoke is persisted, not optimistic).
    await page.reload();
    await expect(
      page.getByTestId("api-token-row").filter({ hasText: name })
    ).toHaveCount(0);
  });

  test("a token needs a name", async ({ page }) => {
    test.slow();
    await page.goto("/settings/tokens");
    // The create button stays disabled with an empty name, so the refusal is
    // structural rather than an error message after the fact.
    await expect(page.getByTestId("api-token-create")).toBeDisabled();
  });
});
