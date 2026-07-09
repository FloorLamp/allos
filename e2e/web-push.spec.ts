import { test, expect } from "@playwright/test";

// Web Push subscribe UI (issue #17). A REAL end-to-end push can't run headless:
// it needs a live browser push service (FCM/Mozilla) plus a registered service
// worker, neither of which exists in CI. So we stub the browser Push API surface
// (serviceWorker.ready → a fake registration whose pushManager subscribes to a
// fake endpoint) and drive the genuine server actions + SQLite round trip:
// enabling STORES the subscription, disabling REMOVES it. The distinguishing
// signal is the "Send test" action's own report — it says "No subscribed
// browsers" only when the login has zero rows server-side, so its message flips
// exactly as the DB row is created and deleted.
//
// LIMITATION (documented): actual push delivery (encryption + the push service
// POST) is out of scope for the browser test; the unit tests
// (lib/__tests__/push.test.ts) cover the pure payload/parse/prune logic instead.

const FAKE_ENDPOINT = "https://127.0.0.1:9/allos-e2e-fake-endpoint";

test.describe("Web Push subscribe UI", () => {
  test("enable stores a subscription; disable removes it", async ({ page }) => {
    // Stub the Push API BEFORE any app script runs. A single in-page `sub`
    // variable models this browser's subscription; subscribe()/unsubscribe()
    // flip it, and getSubscription() reflects it.
    await page.addInitScript(
      ({ endpoint }) => {
        const fakeSub = {
          endpoint,
          expirationTime: null,
          options: {},
          getKey: () => null,
          toJSON: () => ({
            endpoint,
            expirationTime: null,
            keys: { p256dh: "FAKE_P256DH_KEY", auth: "FAKE_AUTH_SECRET" },
          }),
          unsubscribe: async () => {
            current = null;
            return true;
          },
        };
        let current: typeof fakeSub | null = null;
        const registration = {
          pushManager: {
            subscribe: async () => {
              current = fakeSub;
              return fakeSub;
            },
            getSubscription: async () => current,
            permissionState: async () => "granted",
          },
        };
        // Shadow the prototype getter with an instance property.
        Object.defineProperty(navigator.serviceWorker, "ready", {
          configurable: true,
          get: () => Promise.resolve(registration),
        });
        // Force a supported + granted environment.
        window.PushManager = window.PushManager || function () {};
        Object.defineProperty(Notification, "permission", {
          configurable: true,
          get: () => "granted",
        });
        // Notification.requestPermission may not exist / prompt in headless.
        Notification.requestPermission = async () => "granted";
      },
      { endpoint: FAKE_ENDPOINT }
    );

    await page.goto("/settings");

    const card = page.getByTestId("push-settings");
    await expect(card).toBeVisible();
    await expect(page.getByTestId("push-status")).toContainText("Not enabled");

    // Baseline: with no row stored, a test send reports zero browsers.
    await page.getByTestId("push-test").click();
    await expect(page.getByTestId("push-result")).toContainText(
      "No subscribed browsers"
    );

    // Enable → the fake subscription is stored via the real server action.
    await page.getByTestId("push-enable").click();
    await expect(page.getByTestId("push-status")).toContainText(
      "Enabled on this browser"
    );

    // Now the login HAS a subscription server-side: the test send no longer
    // reports zero browsers (it attempts a real send to the fake endpoint, which
    // fails at the network — proving a row exists and was targeted).
    await page.getByTestId("push-test").click();
    await expect(page.getByTestId("push-result")).not.toContainText(
      "No subscribed browsers"
    );

    // Disable → the row is removed via the real server action.
    await page.getByTestId("push-disable").click();
    await expect(page.getByTestId("push-status")).toContainText("Not enabled");

    // Back to zero browsers server-side.
    await page.getByTestId("push-test").click();
    await expect(page.getByTestId("push-result")).toContainText(
      "No subscribed browsers"
    );
  });
});
