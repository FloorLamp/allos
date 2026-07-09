import { test, expect, type Page } from "@playwright/test";
import { totp } from "../lib/totp";

// Optional TOTP 2FA (issue #23): enroll a login, then prove the login flow stops
// at a second-factor step and completes with both a computed authenticator code
// and a one-time recovery code. Uses a throwaway member login in fresh, cookie-
// less contexts so it never touches the shared admin session the other specs
// reuse (enabling/using 2FA here can't log anyone else out).

// Submit computed TOTP codes until the login completes. The replay guard rejects a
// code whose step was already spent (e.g. the enrollment step, if login lands in
// the same 30s window), so on a miss we wait for the next step and recompute.
async function completeTotpLogin(page: Page, secret: string): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await page.getByTestId("totp-code").fill(totp(secret)!);
    await page.getByRole("button", { name: "Verify" }).click();
    try {
      await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
        timeout: 5_000,
      });
      return;
    } catch {
      // Same-window replay or a step-boundary miss — advance past the step and retry.
      await page.waitForTimeout(31_000);
    }
  }
  throw new Error("TOTP login did not complete");
}

test("2FA: enroll, then second-factor login with code and recovery code (#23)", async ({
  page,
  browser,
}) => {
  // Unique per run so a CI retry against the same persistent DB doesn't collide
  // on the NOCASE-unique username.
  const user = `twofa${Date.now()}`;
  const pass = "member-pass-1234"; // passes the strength gate; no username inside

  // As admin (shared session): create the member login + grant it a profile so it
  // has a usable session.
  await page.goto("/settings/family");
  await page.getByPlaceholder("Username").fill(user);
  await page.getByPlaceholder("Password").fill(pass);
  await page.getByRole("button", { name: "Create login" }).click();
  const grantRow = page.getByTestId(`grant-row-${user}`);
  await expect(grantRow).toBeVisible();
  await grantRow.locator('input[type="checkbox"]').first().check();
  await grantRow.getByRole("button", { name: "Save access" }).click();
  await expect(grantRow.getByText("Access updated.")).toBeVisible();

  // As the member (fresh context): enroll in 2FA on Settings → Preferences.
  const enrollCtx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const m = await enrollCtx.newPage();
  await m.goto("/login");
  await m.fill('input[name="username"]', user);
  await m.fill('input[name="password"]', pass);
  await m.click('button[type="submit"]');
  await m.waitForURL((u) => !u.pathname.startsWith("/login"), {
    timeout: 20_000,
  });
  await m.goto("/settings");
  await m.getByTestId("twofa-enable").click();
  const secret = (await m.getByTestId("twofa-secret").innerText()).trim();
  await m.getByTestId("twofa-code").fill(totp(secret)!);
  await m.getByTestId("twofa-activate").click();
  // Recovery codes are shown once on activation; grab one for the recovery path.
  await expect(m.getByTestId("twofa-recovery-codes")).toBeVisible();
  const recoveryCode = (
    await m
      .getByTestId("twofa-recovery-codes")
      .locator("li")
      .first()
      .innerText()
  ).trim();
  await enrollCtx.close();

  // Fresh context: the password now leads to the second-factor step (NOT a
  // session), a wrong code is rejected, and a correct code completes the login.
  const loginCtx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const p = await loginCtx.newPage();
  await p.goto("/login");
  await p.fill('input[name="username"]', user);
  await p.fill('input[name="password"]', pass);
  await p.click('button[type="submit"]');
  await expect(p.getByTestId("totp-code")).toBeVisible();
  await expect(p).toHaveURL(/\/login/); // still not authenticated

  await p.getByTestId("totp-code").fill("000000");
  await p.getByRole("button", { name: "Verify" }).click();
  await expect(p.getByRole("alert")).toBeVisible();

  await completeTotpLogin(p, secret);
  await loginCtx.close();

  // Fresh context: the one-time recovery code also satisfies the second factor.
  const recCtx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  const r = await recCtx.newPage();
  await r.goto("/login");
  await r.fill('input[name="username"]', user);
  await r.fill('input[name="password"]', pass);
  await r.click('button[type="submit"]');
  await expect(r.getByTestId("totp-code")).toBeVisible();
  await r.getByTestId("totp-code").fill(recoveryCode);
  await r.getByRole("button", { name: "Verify" }).click();
  await r.waitForURL((u) => !u.pathname.startsWith("/login"), {
    timeout: 20_000,
  });
  await recCtx.close();
});
