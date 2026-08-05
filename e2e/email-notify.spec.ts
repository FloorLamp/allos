import { test, expect } from "./fixtures";
import Database from "better-sqlite3";
import fs from "node:fs";
import { settledCheck, settledClick } from "./helpers";
import { loginAs } from "./nav";
import { E2E_LOGIN_EMAIL_NOTIFY, E2E_MEMBER_PASSWORD } from "./fixture-logins";
import { workerDbPath, workerMailboxPath } from "./worker-env";

// The email notification channel (issue #1855): the Channels card's graceful
// degradation, the enable + content-mode save (content-free by default), the
// matrix's fourth column, and a send-test captured to this worker's mailbox
// (EMAIL_TEST_CAPTURE — no SMTP server involved).
//
// One self-contained journey on a DEDICATED login/profile (the channel state is
// LOGIN-scoped and persists), starting from a deterministically-reset state so it
// is robust under --repeat-each. It touches the GLOBAL SMTP config (like
// email-auth.spec.ts, which resets it at ITS start) and restores it to
// unconfigured at the end.

const MAILBOX = workerMailboxPath();
// Per-worker-run-unique address, so capture greps and the NOCASE-unique
// logins.email column never collide across repeats or with other specs.
const SUFFIX = Math.random().toString(36).slice(2, 8);
const ADDRESS = `email-notify-${SUFFIX}@example.com`;

function withDb<T>(f: (db: Database.Database) => T): T {
  const db = new Database(workerDbPath());
  try {
    db.pragma("busy_timeout = 5000");
    return f(db);
  } finally {
    db.close();
  }
}

function setSmtpConfigured(configured: boolean): void {
  withDb((db) => {
    const up = db.prepare(
      "INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"
    );
    up.run("smtp_host", configured ? "smtp.example.com" : "");
    up.run("smtp_port", "587");
    up.run("smtp_from", configured ? "allos@example.com" : "");
  });
}

function setLoginAddress(email: string | null): void {
  withDb((db) => {
    db.prepare("UPDATE logins SET email = ? WHERE username = ?").run(
      email,
      E2E_LOGIN_EMAIL_NOTIFY
    );
  });
}

// Reset the fixture login's channel state (login_settings) so every repeat starts
// from the shipped defaults: channel off, content-free, no column overrides.
function resetChannelState(): void {
  withDb((db) => {
    db.prepare(
      `DELETE FROM login_settings
        WHERE key LIKE 'email_notify_%'
          AND login_id = (SELECT id FROM logins WHERE username = ?)`
    ).run(E2E_LOGIN_EMAIL_NOTIFY);
  });
}

// The captured mails addressed to THIS run's address, oldest → newest.
function mailsToAddress(): string[] {
  const raw = fs.existsSync(MAILBOX) ? fs.readFileSync(MAILBOX, "utf8") : "";
  return raw.split("\n").filter((l) => l.includes(ADDRESS));
}

test.describe("email notification channel (#1855)", () => {
  test("channel card degrades honestly, saves content-free by default, joins the matrix, and send-test honors the content mode", async ({
    browser,
  }) => {
    test.slow();
    setSmtpConfigured(false);
    setLoginAddress(null);
    resetChannelState();

    const member = await loginAs(browser, {
      username: E2E_LOGIN_EMAIL_NOTIFY,
      password: E2E_MEMBER_PASSWORD,
    });
    try {
      // ── Unconfigured state: the card names BOTH missing prerequisites ──────
      await member.goto("/settings/notifications");
      const card = member.getByTestId("login-email");
      await expect(card).toBeVisible();
      await expect(member.getByTestId("login-email-no-smtp")).toBeVisible();
      await expect(member.getByTestId("login-email-no-address")).toBeVisible();
      // Unconfigured channel ⇒ the matrix column header says "not set up", and
      // there is no email recipient — but the column itself renders.
      await expect(member.getByTestId("matrix-column-all-email")).toBeVisible();

      // ── Configure SMTP + the login address; the notes clear ────────────────
      setSmtpConfigured(true);
      setLoginAddress(ADDRESS);
      await member.reload();
      await expect(card).toBeVisible();
      await expect(member.getByTestId("login-email-no-smtp")).toHaveCount(0);
      await expect(member.getByTestId("login-email-no-address")).toHaveCount(0);
      await expect(member.getByTestId("login-email-address")).toContainText(
        ADDRESS
      );

      // ── Enable: content-free is the pre-selected default ───────────────────
      await settledCheck(
        member,
        member.getByTestId("login-email-enabled"),
        true
      );
      await expect(member.getByTestId("email-content-free")).toBeChecked();
      await expect(member.getByTestId("email-full-content")).not.toBeChecked();
      await settledClick(member, card.getByRole("button", { name: "Save" }));

      // Persisted: a fresh render shows the channel on, and the matrix's email
      // column is now deliverable for this profile.
      await member.reload();
      await expect(member.getByTestId("login-email-enabled")).toBeChecked();
      await expect(member.getByTestId("email-content-free")).toBeChecked();

      // ── The matrix column: a real cell persists; button-only kinds are out ──
      await expect(
        member.getByTestId("matrix-unavailable-email-food")
      ).toBeVisible();
      await expect(member.getByTestId("matrix-cell-email-food")).toHaveCount(0);
      const refill = member.getByTestId("matrix-cell-email-refill");
      await expect(refill).toBeChecked(); // absence of overrides = every kind on
      // State-relative + self-restoring (the routing checkbox is optimistic —
      // re-click until the flip proves onChange fired, then wait for re-enable;
      // the settings-ia #830 pattern).
      const toggleCell = async (to: boolean) => {
        await expect(async () => {
          await refill.click();
          await expect(refill).toBeChecked({ checked: to });
        }).toPass(); // topass-ok: re-click the routing cell until the optimistic flip proves onChange fired — 'my click landed' is non-atomic with no navigation to follow (#830)
        await expect(refill).toBeEnabled();
      };
      await toggleCell(false);
      await member.reload();
      await expect(
        member.getByTestId("matrix-cell-email-refill")
      ).not.toBeChecked();
      await toggleCell(true);

      // ── Send test, content-free: the mail carries no message content ───────
      const before = mailsToAddress().length;
      await settledClick(member, member.getByTestId("login-email-send-test"));
      await expect(member.getByTestId("login-email-test-result")).toContainText(
        "Sent"
      );
      await expect(() => {
        expect(mailsToAddress().length).toBeGreaterThan(before);
      }).toPass(); // topass-ok: the capture file is appended by the server process after the action returns; polling the file is the only observable
      const freeMail = mailsToAddress().at(-1)!;
      expect(freeMail).toContain("something needs your attention");
      expect(freeMail).not.toContain("Email notifications are working");

      // ── Widen to full content (the user's own tap) and send again ──────────
      await settledCheck(
        member,
        member.getByTestId("email-full-content"),
        true
      );
      const beforeFull = mailsToAddress().length;
      await settledClick(member, member.getByTestId("login-email-send-test"));
      await expect(member.getByTestId("login-email-test-result")).toContainText(
        "Sent"
      );
      await expect(() => {
        expect(mailsToAddress().length).toBeGreaterThan(beforeFull);
      }).toPass(); // topass-ok: same file-append observable as above
      expect(mailsToAddress().at(-1)!).toContain(
        "Email notifications are working"
      );
    } finally {
      // Leave the global SMTP config as the suite expects it: unconfigured.
      setSmtpConfigured(false);
      await member.context().close();
    }
  });
});
