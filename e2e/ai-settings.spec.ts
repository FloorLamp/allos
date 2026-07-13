import { test, expect } from "@playwright/test";

// The admin Server settings page surfaces the active AI backend read-only
// (issue #43): endpoint label, model, and configured state. The e2e DB boots
// without ANTHROPIC_API_KEY/AI_BASE_URL, so it shows the default endpoint and
// the offline/not-configured status.
test.describe("Settings → Server: AI endpoint info", () => {
  test("shows the read-only AI endpoint and model", async ({ page }) => {
    await page.goto("/settings/server");
    const info = page.getByTestId("ai-endpoint-info");
    await expect(info).toBeVisible();
    // Default endpoint label (no AI_BASE_URL configured in the e2e env).
    await expect(info.getByText("Anthropic API")).toBeVisible();
    // The model row is present (env-driven; default model in the e2e env).
    await expect(info.getByText("Model", { exact: true })).toBeVisible();
    // Env-driven, not editable: the explanatory note names the env vars.
    await expect(info.getByText(/AI_BASE_URL/).first()).toBeVisible();
  });

  // The global per-profile daily recommendation-run clamp (issue #424) lives on
  // the admin Server tab. Admin-only, so this authenticated-as-admin spec can edit
  // it; the value persists across a reload.
  test("admin can set the recommendation runs-per-day clamp", async ({
    page,
  }) => {
    await page.goto("/settings/server");
    const input = page.getByTestId("recommendation-max-runs");
    await expect(input).toBeVisible();
    await input.fill("3");
    await input.blur();
    // Wait for the autosave to COMMIT before reloading — a reload aborts the
    // in-flight server-action POST, silently losing the save (the race that made
    // this spec chronically flaky). SaveStatus renders aria-label="Saved" on
    // success (the audit-retention / risk-factors pattern).
    await expect(page.getByLabel("Saved").first()).toBeVisible();
    // Reload and confirm it stuck.
    await page.reload();
    await expect(page.getByTestId("recommendation-max-runs")).toHaveValue("3");
    // Restore the default so we don't perturb other admin-scoped specs.
    const restore = page.getByTestId("recommendation-max-runs");
    await restore.fill("1");
    await restore.blur();
    await expect(page.getByLabel("Saved").first()).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("recommendation-max-runs")).toHaveValue("1");
  });
});

// The per-profile AI recommendation cadence (issue #424) lives on the Profile tab.
// It's admin-editable only; this spec runs as admin, so the picker is enabled and
// its value persists.
test.describe("Settings → Profile: recommendation cadence", () => {
  test("admin can pick a recommendation cadence for the active profile", async ({
    page,
  }) => {
    await page.goto("/settings/profile");
    const form = page.getByTestId("recommendation-cadence-form");
    await expect(form).toBeVisible();
    const select = page.getByTestId("recommendation-cadence");
    await expect(select).toBeEnabled();
    await select.selectOption("weekly");
    // Same save-commit wait as above: never reload across an in-flight autosave.
    await expect(page.getByLabel("Saved").first()).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("recommendation-cadence")).toHaveValue(
      "weekly"
    );
    // Restore the default (on-upload-only) so other specs see a stable profile.
    await page
      .getByTestId("recommendation-cadence")
      .selectOption("on-upload-only");
    await expect(page.getByLabel("Saved").first()).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("recommendation-cadence")).toHaveValue(
      "on-upload-only"
    );
  });
});
