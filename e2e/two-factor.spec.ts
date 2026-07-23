import { test, expect, type Page } from "@playwright/test";
import { totp } from "../lib/totp";
import { createLoginViaFamily, setGrantsViaFamily } from "./family-helpers";

// Optional TOTP 2FA (issue #23): enroll a login, then prove the login flow stops
// at a second-factor step and completes with both a computed authenticator code
// and a one-time recovery code. Uses a throwaway member login in fresh, cookie-
// less contexts so it never touches the shared admin session the other specs
// reuse (enabling/using 2FA here can't log anyone else out).

// Complete the second-factor step with a code for the NEXT 30s step. The replay
// guard rejects any step at or before the last spent one (enrollment spends the
// current step when login lands in the same window), and the verifier accepts a
// ±1-step window — so the next step's code is BOTH always fresh (monotonically
// greater than enrollment's) and always in-window. Deterministic: no sleeping
// through step boundaries (a 31s wait blew the 30s test timeout in CI).
async function completeTotpLogin(page: Page, secret: string): Promise<void> {
  // Under heavy full-suite load, more than a step can elapse between computing
  // the code and the server verifying it, sliding even the next-step code out of
  // the ±1-step window (#961 — failed exactly so twice, only in loaded runs).
  // toPass is justified: "a code computed now is verified in time" is non-atomic
  // under load and no single expect can express it. Each retry computes a FRESH
  // next-step code (strictly newer, so the replay guard never blocks a retry),
  // and the loop cannot false-pass — only a real verify navigates off /login.
  // The url guard keeps a slow-but-successful verify from being re-driven.
  await expect(async () => {
    if (new URL(page.url()).pathname.startsWith("/login")) {
      const nextStepCode = totp(secret, { timeMs: Date.now() + 30_000 })!;
      await page.getByTestId("totp-code").fill(nextStepCode);
      await page.getByRole("button", { name: "Verify" }).click();
    }
    await page.waitForURL((u) => !u.pathname.startsWith("/login"), {
      timeout: 10_000,
    });
  }).toPass({ timeout: 45_000 }); // topass-ok: re-verify with a freshly minted TOTP until off /login — the time-based code can expire between attempts, so code+submit is re-driven
}

test("2FA: enroll, then second-factor login with code and recovery code (#23)", async ({
  page,
  browser,
}) => {
  // This test drives two hardened multi-step Family operations (create login, then
  // grant a profile — each a fresh /settings/family navigation) BEFORE the 2FA enroll/
  // login arc, so it needs the extended budget its sibling view-only-access already
  // uses; without it the create+grant pair intermittently bumps the 30s default (seen
  // at --repeat-each=3, CI-equivalent).
  test.slow();
  // As admin (shared session): create the member login + grant it the seeded profile
  // so it has a usable session. Both steps go through the shared family helpers, which
  // harden the onClick+router.refresh() create/grant against the hydration swallow and
  // the toaster-poll false-settle (#830/#1111). createLoginViaFamily returns a
  // per-run-unique username so a CI retry against the persistent DB can't collide.
  const { username: user, password: pass } = await createLoginViaFamily(page);
  await setGrantsViaFamily(page, user, { profileId: 1, access: "write" });

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
  // Activation is the same stall hazard as the login verify (#961): a current-step
  // code computed here can expire before the server checks it under full-suite
  // load, and the recovery codes then never render (the observed failure).
  // toPass justified as in completeTotpLogin — recompute a fresh code per retry;
  // only a real activation renders the one-time recovery codes, so no false pass.
  await expect(async () => {
    if (!(await m.getByTestId("twofa-recovery-codes").isVisible())) {
      await m.getByTestId("twofa-code").fill(totp(secret)!);
      await m.getByTestId("twofa-activate").click();
    }
    // Recovery codes are shown once on activation; the recovery path needs one.
    await expect(m.getByTestId("twofa-recovery-codes")).toBeVisible({
      timeout: 5000,
    });
  }).toPass({ timeout: 45_000 }); // topass-ok: re-activate with a fresh TOTP until the one-time recovery codes render — time-based code, re-driven per attempt
  const recoveryCode = (
    await m
      .getByTestId("twofa-recovery-codes")
      .locator("li")
      .first() // first-ok: any one of THIS login's freshly-shown recovery codes; the recovery path needs exactly one
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
  // Next's route announcer is also role=alert — assert the actual error text.
  await expect(p.getByText("Incorrect or expired code.")).toBeVisible();

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
