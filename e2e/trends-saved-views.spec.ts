import { test, expect } from "./fixtures";

// Saved views are gone: the Trends overhaul removed the chrome, and #1653 removed
// the Server Actions, settings accessors and list math behind it. Keep this browser
// guard because an existing profile still carries stored `trend_views` rows —
// scripts/seed.ts plants a pair on profile 1 exactly as an upgraded database has
// them. That inert data must not make the old Views strip or Save current button
// reappear.
test("saved-view controls are absent from desktop Trends", async ({ page }) => {
  await page.goto("/trends?view=tiles&range=all");

  await expect(page.getByRole("button", { name: "Save current" })).toHaveCount(
    0
  );
  await expect(page.getByText("Views", { exact: true })).toHaveCount(0);
  await expect(page.getByPlaceholder("View name…")).toHaveCount(0);
});
