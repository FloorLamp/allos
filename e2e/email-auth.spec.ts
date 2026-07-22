import { test, expect, type Browser } from "@playwright/test";
import fs from "node:fs";
import { settledClick, settledFill, followLink } from "./helpers";
import { loginAs } from "./nav";

// Outbound email — SMTP foundation + login-lifecycle flows (issue #985). One
// self-contained journey (so it's robust under --repeat-each): it OWNS the global
// SMTP/public-URL config, resetting it to unconfigured at the start of the run and
// again at the end, and uses per-run-unique usernames/emails so nothing collides
// across repeats or with other specs. Email is captured to e2e/.data/mailbox.jsonl
// by the lib/email chokepoint (EMAIL_TEST_CAPTURE, set in playwright.config.ts) —
// no SMTP server involved.

const MAILBOX = "e2e/.data/mailbox.jsonl";
const SUFFIX = Math.random().toString(36).slice(2, 8);
const SET_PW = "New-Pass-9xqm!"; // passes checkPasswordStrength
const TEMP_PW = "Temp-Pass-9xqm!";

// Extract the newest set-password token addressed to `email` from the capture file.
function tokenFor(email: string): string {
  const raw = fs.existsSync(MAILBOX) ? fs.readFileSync(MAILBOX, "utf8") : "";
  const line = raw
    .split("\n")
    .filter((l) => l.includes(email) && l.includes("set-password"))
    .at(-1);
  expect(line, `no captured email to ${email}`).toBeTruthy();
  const m = line!.match(/set-password\?token=([0-9a-f]+)/);
  expect(m, `no set-password token in mail to ${email}`).toBeTruthy();
  return m![1];
}

async function cookielessPage(browser: Browser) {
  const ctx = await browser.newContext({
    storageState: { cookies: [], origins: [] },
  });
  return ctx.newPage();
}

// Configure/clear the global SMTP + public URL via Settings → Server (admin). These
// are CONTROLLED React inputs whose Save builds its FormData from component STATE
// (PublicUrlSettings/SmtpSettings), so a pre-hydration `.fill()` that never fired
// onChange persists the empty/stale value (a VALID save — normalizePublicUrl("") is
// ok), the ~1/3-under-load email-auth:58 flake. Two guards, belt-and-suspenders:
// settledFill waits for React to hydrate the field before filling (value lands in
// state), AND setSettingAndConfirm retries the whole navigate→fill→save and CONFIRMS
// it durably persisted by reloading — the reload also settles the DERIVED
// smtp-needs-public-url warning, which a single apply→revalidate render can still
// race. settledFill alone got 10/12; the retry+confirm closes the last 2.
async function setSettingAndConfirm(
  page: import("@playwright/test").Page,
  fill: () => Promise<void>,
  saveButton: () => import("@playwright/test").Locator,
  confirm: () => Promise<void>
) {
  await expect(async () => {
    await page.goto("/settings/server");
    await fill();
    await settledClick(page, saveButton());
    await page.goto("/settings/server"); // fresh render reads the persisted setting
    await confirm();
  }).toPass({ timeout: 30_000 }); // topass-ok: retry the controlled-input fill+save until it durably persists (pre-hydration fill-revert); reload confirms
}

async function setSmtp(page: import("@playwright/test").Page, host: string) {
  const hostField = () => page.getByTestId("smtp-host");
  await setSettingAndConfirm(
    page,
    async () => {
      await settledFill(page, hostField(), host);
      await settledFill(page, page.getByTestId("smtp-port"), "587");
      await settledFill(
        page,
        page.getByTestId("smtp-from"),
        host ? "allos@example.com" : ""
      );
    },
    () => page.getByTestId("smtp-apply"),
    async () => {
      await expect(hostField()).toHaveValue(host);
    }
  );
}
async function setPublicUrl(
  page: import("@playwright/test").Page,
  url: string
) {
  const card = () => page.locator(".card", { hasText: "Public app URL" });
  const field = () => card().getByPlaceholder("https://your-app.example.com");
  await setSettingAndConfirm(
    page,
    async () => {
      await settledFill(page, field(), url);
    },
    () => card().getByRole("button", { name: "Save" }),
    async () => {
      // A non-empty URL persists (normalized); empty stays empty.
      if (url) await expect(field()).not.toHaveValue("");
      else await expect(field()).toHaveValue("");
    }
  );
}

test.describe("outbound email — login lifecycle (#985)", () => {
  test("unconfigured hides affordances; invite + reset round trips work", async ({
    page,
    browser,
  }) => {
    test.slow(); // local `next dev` compiles routes on first hit

    // ── Start clean: no SMTP, no public URL ─────────────────────────────────
    await setPublicUrl(page, "");
    await setSmtp(page, "");

    // (3) unconfigured SMTP ⇒ the "Forgot password?" affordance is hidden.
    let anon = await cookielessPage(browser);
    await anon.goto("/login");
    await expect(anon.getByTestId("forgot-password-link")).toHaveCount(0);
    await anon.context().close();

    // Configure SMTP but NOT the public URL.
    await setSmtp(page, "smtp.example.com");
    // (4) missing public URL blocks send — honest copy on the SMTP card.
    await expect(page.getByTestId("smtp-needs-public-url")).toBeVisible();
    // Still hidden on /login (canSendAuthEmail needs the public URL too).
    anon = await cookielessPage(browser);
    await anon.goto("/login");
    await expect(anon.getByTestId("forgot-password-link")).toHaveCount(0);
    await anon.context().close();

    // Set the public URL — now email is fully configured. setPublicUrl confirmed the
    // URL durably persisted (reload-verified), so the derived warning is gone.
    await setPublicUrl(page, "app.example.com");
    await expect(page.getByTestId("smtp-needs-public-url")).toHaveCount(0);

    // ── (2) Invite flow from Family settings ────────────────────────────────
    const invitee = `invitee-${SUFFIX}`;
    const inviteeEmail = `invitee-${SUFFIX}@example.com`;
    await page.goto("/settings/family");
    await page.getByPlaceholder("Username").fill(invitee);
    await page.getByPlaceholder("Password").fill(TEMP_PW);
    await page.getByPlaceholder("Email (optional)").fill(inviteeEmail);
    // Admin role so the invited login can see the app (a member with no granted
    // profile has nowhere to land) — this spec is about the email flow, not grants.
    await page.getByTestId("create-role").selectOption("admin");
    await page.getByTestId("create-invite").check();
    await settledClick(
      page,
      page.getByRole("button", { name: "Create login" })
    );

    // Follow the invite link (captured mail) and set a password.
    const invPage = await cookielessPage(browser);
    await invPage.goto(`/set-password?token=${tokenFor(inviteeEmail)}`);
    await expect(
      invPage.getByRole("heading", { name: "Set your password" })
    ).toBeVisible();
    await invPage.getByTestId("new-password").fill(SET_PW);
    await invPage.getByTestId("confirm-password").fill(SET_PW);
    await settledClick(
      invPage,
      invPage.getByRole("button", { name: "Set password" })
    );
    await expect(invPage.getByTestId("set-password-done")).toBeVisible();
    await invPage.context().close();

    // The invited user can now sign in with the password THEY set.
    const inviteeSession = await loginAs(browser, {
      username: invitee,
      password: SET_PW,
    });
    await expect(
      inviteeSession.getByRole("link", { name: "Data" })
    ).toBeVisible();
    await inviteeSession.context().close();

    // ── (1) Forgot-password round trip ──────────────────────────────────────
    const resetter = `resetter-${SUFFIX}`;
    const resetterEmail = `resetter-${SUFFIX}@example.com`;
    await page.goto("/settings/family");
    await page.getByPlaceholder("Username").fill(resetter);
    await page.getByPlaceholder("Password").fill(TEMP_PW);
    await page.getByPlaceholder("Email (optional)").fill(resetterEmail);
    await page.getByTestId("create-role").selectOption("admin");
    await settledClick(
      page,
      page.getByRole("button", { name: "Create login" })
    );

    // From /login → Forgot password? → request a reset.
    const reset = await cookielessPage(browser);
    await reset.goto("/login");
    await followLink(
      reset,
      reset.getByTestId("forgot-password-link"),
      /\/forgot-password/
    );
    await reset.getByTestId("reset-email").fill(resetterEmail);
    await settledClick(
      reset,
      reset.getByRole("button", { name: "Send reset link" })
    );
    await expect(reset.getByTestId("reset-sent")).toBeVisible();
    await reset.goto(`/set-password?token=${tokenFor(resetterEmail)}`);
    await expect(
      reset.getByRole("heading", { name: "Reset your password" })
    ).toBeVisible();
    await reset.getByTestId("new-password").fill(SET_PW);
    await reset.getByTestId("confirm-password").fill(SET_PW);
    await settledClick(
      reset,
      reset.getByRole("button", { name: "Reset password" })
    );
    await expect(reset.getByTestId("set-password-done")).toBeVisible();
    await reset.context().close();

    const resetterSession = await loginAs(browser, {
      username: resetter,
      password: SET_PW,
    });
    await expect(
      resetterSession.getByRole("link", { name: "Data" })
    ).toBeVisible();
    await resetterSession.context().close();

    // ── Cleanup: leave the shared instance unconfigured, as found ───────────
    await setPublicUrl(page, "");
    await setSmtp(page, "");
  });
});
