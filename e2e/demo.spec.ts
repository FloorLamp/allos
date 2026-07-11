import { test, expect } from "@playwright/test";

// Demo-mode surfaces (#181, #278). Runs (via the "demo" project) against the demo
// webServer booted with ALLOS_DEMO_MODE=1, unauthenticated — it drives the demo
// login itself. Asserts the flag effects a browser can see: the persistent
// banner, the login-page credentials card, a blocked edit affordance (the
// disabled medical-upload input), and the trimmed account-management cards on
// Settings (no change-password, no 2FA enrollment — #278). The write-refusal
// itself is covered at the action tier; the default-mode ABSENCE is asserted in
// smoke.spec.ts.

test("login page shows the demo banner and credentials card", async ({
  page,
}) => {
  await page.goto("/login");

  const banner = page.getByTestId("demo-banner");
  await expect(banner).toBeVisible();
  await expect(banner).toContainText("do not enter real health information");

  const card = page.getByTestId("demo-credentials");
  await expect(card).toBeVisible();
  await expect(card.getByTestId("demo-username")).toHaveText("demo");
  await expect(card.getByTestId("demo-password")).toHaveText("demo");
});

test("the demo user can sign in, sees the banner, and uploads are disabled", async ({
  page,
}) => {
  // Sign in with the advertised demo credentials.
  await page.goto("/login");
  await page.fill('input[name="username"]', "demo");
  await page.fill('input[name="password"]', "demo");
  await page.click('button[type="submit"]');
  await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
    timeout: 20_000,
  });

  // The persistent banner is on the authenticated app too.
  await expect(page.getByTestId("demo-banner")).toBeVisible();

  // Blocked edit affordance: the medical-upload input is disabled with a hint.
  await page.goto("/data?section=import");
  const input = page.getByTestId("medical-upload-input");
  await expect(input).toBeVisible();
  await expect(input).toBeDisabled();
  await expect(page.getByTestId("upload-disabled-hint")).toBeVisible();

  // Account-management surfaces are trimmed for the shared demo login (#278):
  // no 2FA enrollment card and no change-password card — a visitor must not be
  // able to lock other visitors out. The active-sessions list stays readable
  // (asserted visible, which also proves the page rendered before the absence
  // assertions below mean anything).
  await page.goto("/settings");
  await expect(
    page.getByRole("heading", { name: "Active sessions" })
  ).toBeVisible();
  await expect(page.getByTestId("twofa-card")).toHaveCount(0);
  await expect(
    page.getByRole("heading", { name: "Password", exact: true })
  ).toHaveCount(0);
});
