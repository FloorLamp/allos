import { test as setup, expect } from "@playwright/test";
import fs from "node:fs";

// Log in once and persist the session cookie; the real specs reuse it via
// storageState (see playwright.config.ts) so they start authenticated. The
// admin credentials match the webServer's ADMIN_USERNAME/ADMIN_PASSWORD.
const authFile = "e2e/.auth/state.json";

setup("authenticate", async ({ page }) => {
  await page.goto("/login");
  await page.fill('input[name="username"]', "admin");
  await page.fill('input[name="password"]', "e2e-admin-pass");
  await page.click('button[type="submit"]');

  // Land anywhere off the login page = authenticated.
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
    timeout: 20_000,
  });
  await expect(page.getByRole("link", { name: "Data" })).toBeVisible();

  fs.mkdirSync("e2e/.auth", { recursive: true });
  await page.context().storageState({ path: authFile });
});
