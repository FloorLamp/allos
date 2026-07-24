import { test, expect, type Page } from "@playwright/test";
import Database from "better-sqlite3";
import path from "node:path";
import { totp } from "../lib/totp";
import { hashPasswordSync } from "../lib/password";
import { E2E_MEMBER_PASSWORD } from "./fixture-logins";

// Optional TOTP 2FA (issue #23): enroll a login, then prove the login flow stops
// at a second-factor step and completes with both a computed authenticator code
// and a one-time recovery code. Uses a throwaway member login in fresh, cookie-
// less contexts so it never touches the shared admin session the other specs
// reuse (enabling/using 2FA here can't log anyone else out).

// DB-seed a fresh member login granted profile 1 (write) and return its credentials.
// This test MUTATES 2FA state (enroll, then consume a one-time recovery code), so it
// needs a THROWAWAY login per run — it can't reuse a static seeded fixture. But it does
// NOT need the Family UI to mint one: seeding directly replaces the former
// createLoginViaFamily/setGrantsViaFamily pair, whose onClick+router.refresh() create/grant
// went stale under CI load (the #830/#1111 census flake that failed shard 4). The username
// is per-run-unique so a retry against the persistent e2e DB can't collide on the
// NOCASE-unique username.
let memberSeq = 0;

function e2eDbPath(): string {
  return (
    process.env.ALLOS_DB_PATH ??
    path.join(process.cwd(), "e2e", ".data", "e2e.db")
  );
}

function seedMemberOnProfile1(): { username: string; password: string } {
  const username = `e2e_2fa_${Date.now()}_${++memberSeq}`;
  const db = new Database(e2eDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    const loginId = Number(
      db
        .prepare(
          "INSERT INTO logins (username, password_hash, role) VALUES (?, ?, 'member')"
        )
        .run(username, hashPasswordSync(E2E_MEMBER_PASSWORD)).lastInsertRowid
    );
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, 1, 'write')"
    ).run(loginId);
  } finally {
    db.close();
  }
  return { username, password: E2E_MEMBER_PASSWORD };
}

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
  browser,
}) => {
  // The 2FA enroll/login arc still compiles the login/settings routes on first hit, so
  // keep the extended budget.
  test.slow();
  // DB-seed the throwaway member login + its profile-1 grant directly (no shared admin
  // session, no Family UI) so the flaky create/grant render path can't stall the setup.
  const { username: user, password: pass } = seedMemberOnProfile1();

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
