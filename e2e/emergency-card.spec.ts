import { test, expect } from "@playwright/test";

// Offline Emergency Card (issue #42). This spec runs in its OWN unauthenticated
// context and logs in by hand (rather than reusing the shared storageState),
// because it exercises logout — which destroys the session row server-side, and
// would otherwise invalidate the shared cookie every other spec relies on.
test.use({ storageState: { cookies: [], origins: [] } });

const LS_KEY = "allos:emergency-card";

async function login(page: import("@playwright/test").Page) {
  await page.goto("/login");
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="password"]', "e2e-admin-pass");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
    timeout: 20_000,
  });
}

test("emergency card: opt-in, render, offline copy, and logout clears it (#42)", async ({
  page,
  context,
}) => {
  // Several full navigations + a bounded SW wait; give it headroom under the
  // parallel load of the full suite.
  test.slow();
  await login(page);

  // 1. Opt in on Settings → Profile (off by default). Wait for the autosave
  //    "Saved" indicator so the write has landed before we read the card.
  await page.goto("/settings/profile");
  const toggle = page.getByTestId("emergency-toggle");
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(page.getByLabel("Saved").first()).toBeVisible();

  // 2. The card renders the seeded allergy + active medication.
  await page.goto("/emergency");
  await expect(page.getByTestId("emergency-card")).toBeVisible();
  await expect(page.getByTestId("emergency-allergies")).toContainText(
    "Peanuts"
  );
  await expect(page.getByTestId("emergency-medications")).toContainText(
    "Sertraline"
  );

  // 3. The visit cached an offline copy in localStorage (written by a client
  //    effect after hydration, so poll rather than read once).
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), LS_KEY))
    .toContain("Peanuts");

  // 4. The public /offline fallback (the exact page the service worker serves for
  //    a failed navigation) surfaces that cached copy instead of dead-ending.
  await page.goto("/offline");
  await page.getByTestId("offline-view-emergency").click();
  await expect(page.getByTestId("emergency-card")).toContainText("Peanuts");

  // 4b. Genuine offline render. Only the CI harness boots a production build with a
  //     live service worker (local `next dev` unregisters it), so gate on CI rather
  //     than sniffing for a controller — dev SW state is unreliable and would hang
  //     an offline navigation. Offline, a failed navigation is served the precached
  //     /offline shell, which reads the cached card from localStorage — no network,
  //     still readable.
  if (process.env.CI) {
    await page.waitForFunction(() => !!navigator.serviceWorker?.controller, {
      timeout: 15_000,
    });
    await context.setOffline(true);
    try {
      await page.goto("/emergency");
      await page.getByTestId("offline-view-emergency").click();
      await expect(page.getByTestId("emergency-card")).toContainText("Peanuts");
    } finally {
      await context.setOffline(false);
    }
  }

  // 5. Log out. The offline copy is wiped from this device, and the card is locked
  //    behind auth again.
  await page.goto("/");
  await page.getByTestId("user-menu-trigger").click();
  await page.getByRole("button", { name: "Log out" }).click();
  await page.waitForURL(/\/login/, { timeout: 20_000 });

  const afterLogout = await page.evaluate(
    (k) => localStorage.getItem(k),
    LS_KEY
  );
  expect(afterLogout).toBeNull();

  // A direct visit to the card now redirects to login (no session).
  await page.goto("/emergency");
  await expect(page).toHaveURL(/\/login/);

  // And the offline fallback no longer offers the card (nothing cached).
  await page.goto("/offline");
  await expect(page.getByTestId("offline-view-emergency")).toHaveCount(0);
});
