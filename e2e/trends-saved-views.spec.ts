import { test, expect } from "./fixtures";

// Saved-view management was removed from the Trends chrome. Keep this browser
// guard because an existing profile may still carry stored trend_views data:
// neither that data nor the now-unused actions should make the old Views strip
// or Save current button reappear.
test("saved-view controls are absent from desktop Trends", async ({ page }) => {
  await page.goto("/trends?view=tiles&range=all");

  await expect(page.getByRole("button", { name: "Save current" })).toHaveCount(
    0
  );
  await expect(page.getByText("Views", { exact: true })).toHaveCount(0);
  await expect(page.getByPlaceholder("View name…")).toHaveCount(0);
});
