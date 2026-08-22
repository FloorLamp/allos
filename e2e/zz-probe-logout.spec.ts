import { test, expect } from "./fixtures";
import { readyForOffline } from "./helpers";

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

// Replays the pre-logout half of emergency-card.spec.ts test 1 so the service
// worker is registered and controlling, exactly as it is at line 190.
async function warmServiceWorker(page: import("@playwright/test").Page, context: import("@playwright/test").BrowserContext) {
  await page.goto("/profile");
  const toggle = page.getByTestId("emergency-toggle");
  await expect(toggle).toBeVisible();
  if (!(await toggle.isChecked())) {
    await toggle.check();
    await expect(page.getByLabel("Saved")).toBeVisible();
  }
  await expect(page.getByTestId("emergency-card")).toBeVisible();
  await expect
    .poll(() => page.evaluate((k) => localStorage.getItem(k), LS_KEY))
    .toContain("Peanuts");
  await page.goto("/offline");
  await page.getByTestId("offline-view-emergency").click();
  await expect(page.getByTestId("emergency-card")).toContainText("Peanuts");
  await readyForOffline(page);
  await context.setOffline(true);
  try {
    await page.goto("/profile");
    await page.getByTestId("offline-view-emergency").click();
    await expect(page.getByTestId("emergency-card")).toContainText("Peanuts");
  } finally {
    await context.setOffline(false);
  }
}

for (const sw of [false, true]) {
  for (const rate of [1, 20, 40]) {
    test(`PROBE sw=${sw} rate=${rate}`, async ({ page, context }) => {
      test.slow();
      await login(page);
      if (sw) await warmServiceWorker(page, context);

      const posts: string[] = [];
      page.on("request", (r) => {
        if (r.method() === "POST")
          posts.push(
            `${new URL(r.url()).pathname} next-action=${r.headers()["next-action"] ? "yes" : "no"}`
          );
      });

      // THE THROTTLE MUST SPAN THE LOAD, not just the click: the hydration
      // window opens when "/" starts loading, so throttling after goto() returns
      // measures nothing.
      const cdp = await context.newCDPSession(page);
      if (rate > 1)
        await cdp.send("Emulation.setCPUThrottlingRate", { rate });
      await page.goto("/");

      // The spec's line 190, verbatim: a bare click, no hydration gate.
      await page.getByRole("button", { name: "Log out" }).click();
      let navigated = true;
      try {
        await page.waitForURL(/\/login/, { timeout: 20_000 });
      } catch {
        navigated = false;
      }
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: 1 });

      const state = await page
        .evaluate(() => {
          const btn = Array.from(document.querySelectorAll("button")).find(
            (b) => b.textContent?.trim() === "Log out"
          );
          return {
            buttonPresent: !!btn,
            buttonHydratedNow: btn
              ? Object.keys(btn).some(
                  (k) =>
                    k.startsWith("__reactFiber$") ||
                    k.startsWith("__reactProps$")
                )
              : null,
            controlled: !!navigator.serviceWorker?.controller,
          };
        })
        .catch((e) => ({ evalFailed: String(e) }));

      console.log(
        `[PROBE] sw=${sw} rate=${rate} navigated=${navigated} url=${page.url()} ` +
          `posts=${JSON.stringify(posts)} state=${JSON.stringify(state)}`
      );
    });
  }
}
