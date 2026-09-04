import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import { frozenNow, workerDbPath } from "./worker-env";
import { utcInstant } from "@/lib/date";

// Settings → Server surfaces the persisted notification-delivery failure marker
// (#131) next to the global Telegram bot config. The bot is INSTANCE config (one bot
// serves every profile), so #1462 moved that card — and this marker with it — off the
// member-visible Notifications page onto the admin Server page.
//
// THE SPEC OWNS THE MARKER (#5004). What the card reads is an INSTANCE-WIDE fold over
// `notify_lifecycle` (lib/notifications/delivery-marker.ts readDeliveryMarker), and
// a sibling in the same worker legitimately empties it: saving the admin login's
// Telegram chat id calls invalidateDeliveryOutcome("telegram", loginId), which DELETES
// the row the run seed planted (e2e/food-telegram.spec.ts does exactly that), and a
// bot-token write deletes every Telegram owner's row. So this spec no longer reads the
// seed and hopes: it writes the failing row itself, immediately before the read, and
// clears the other failing rows so the fold has one candidate and cannot return a
// neighbour's push/email/Home Assistant failure instead. Tests in a worker run
// serially, so nothing can reach this state between the write and the assertion —
// which is why the fix is ownership rather than keeping this spec out of some other
// spec's shard.
const SEEDED_ERROR = "Telegram API 401: Unauthorized (bot token revoked)";

// The failing Telegram row for the admin login — the same key, shape and canonical
// instant `recordDeliveryOutcome` writes for a real failed send.
function seedFailedTelegramSend(): void {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const adminLoginId = (
      db
        .prepare("SELECT id FROM logins WHERE role = 'admin' ORDER BY id LIMIT 1")
        .get() as { id: number }
    ).id;
    db.prepare("DELETE FROM notify_lifecycle WHERE state = 'failing'").run();
    db.prepare(
      `INSERT INTO notify_lifecycle (key, state, channel, owner_id, detail, at)
         VALUES (?, 'failing', 'telegram', ?, ?, ?)`
    ).run(
      `delivery-telegram-${adminLoginId}`,
      adminLoginId,
      SEEDED_ERROR,
      utcInstant(frozenNow())
    );
  } finally {
    db.close();
  }
}

test.describe("Settings → Server: notification delivery error", () => {
  test("shows the last delivery failure marker", async ({ page }) => {
    seedFailedTelegramSend();
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
