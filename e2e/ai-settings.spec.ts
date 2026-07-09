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
    await expect(info.getByText("Model")).toBeVisible();
    // Env-driven, not editable: the explanatory note names the env vars.
    await expect(info.getByText(/AI_BASE_URL/)).toBeVisible();
  });
});
