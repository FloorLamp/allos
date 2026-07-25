import { test, expect } from "@playwright/test";

// Settings → Server surfaces the persisted notification-delivery failure marker
// (#131) next to the global Telegram bot config. The bot is INSTANCE config (one bot
// serves every profile), so #1462 moved that card — and this marker with it — off the
// member-visible Notifications page onto the admin Server page. The fixture
// (e2e/seed-events.ts) seeds a failed-send marker; the remediation is the "Send test"
// button, which clears it on a successful send.
test.describe("Settings → Server: notification delivery error", () => {
  test("shows the last delivery failure marker", async ({ page }) => {
    await page.goto("/settings/server");
    const marker = page.getByTestId("notify-last-error");
    await expect(marker).toBeVisible();
    await expect(marker).toContainText("Last notification delivery failed");
    await expect(marker).toContainText("telegram");
    await expect(marker).toContainText("401");
    // Points the operator at the remediation path.
    await expect(marker).toContainText("Send test");
  });
});
