import { test, expect } from "@playwright/test";

// Settings → Notifications surfaces the persisted notification-delivery failure marker
// (#131) next to the global Telegram bot config, so a revoked bot token / broken
// send is visible instead of only surfacing as a notify-tick exit code. The
// fixture (e2e/seed-events.ts) seeds a failed-send marker; the remediation is the
// per-profile "Send test" button on Settings → Notifications, which clears it on a
// successful send.
test.describe("Settings → Notifications: notification delivery error", () => {
  test("shows the last delivery failure marker", async ({ page }) => {
    await page.goto("/settings/notifications");
    const marker = page.getByTestId("notify-last-error");
    await expect(marker).toBeVisible();
    await expect(marker).toContainText("Last notification delivery failed");
    await expect(marker).toContainText("telegram");
    await expect(marker).toContainText("401");
    // Points the operator at the remediation path.
    await expect(marker).toContainText("Send test");
  });
});
