// DB INTEGRATION TIER — the email notification channel (issue #1855). Covers the
// halves the pure tier can't see:
//
//   1. Recipient RESOLUTION over real grant/mute/settings rows: managing logins
//      only (no admin bypass), the enable + address gates, the per-kind column,
//      and the shared-address dedup with its content-free-wins merge.
//   2. The channel SEND end-to-end through the lib/email.ts chokepoint's
//      deterministic test capture: the content-free DEFAULT provably strips the
//      message (no medication name in the mail), full content is per-login
//      opt-in, and a button-only kind / fully-filtered audience is a no-op.
//
// Every value is synthetic (reserved example.com addresses, fictional names).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import {
  setLoginEmailNotify,
  setLoginEmailDisabledKinds,
  setProfileMutedForLogin,
  setSmtpConfig,
  setSetting,
} from "@/lib/settings";
import {
  emailChannel,
  resolveEmailRecipients,
  sendTestEmailToLogin,
} from "@/lib/notifications/email";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}
function newLogin(
  role: "admin" | "member",
  name: string,
  email: string | null
): number {
  return Number(
    db
      .prepare(
        "INSERT INTO logins (username, password_hash, role, email) VALUES (?, 'x', ?, ?)"
      )
      .run(name, role, email).lastInsertRowid
  );
}
function grant(loginId: number, profileId: number): void {
  db.prepare(
    "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write') ON CONFLICT(login_id, profile_id) DO NOTHING"
  ).run(loginId, profileId);
}

// The chokepoint's test capture: each send appends one JSON line. Point it at a
// fresh temp file per test; the env var is read at SEND time (lib/email.ts).
let captureFile: string;
function capturedMails(): { to: string; subject: string; text: string }[] {
  if (!fs.existsSync(captureFile)) return [];
  return fs
    .readFileSync(captureFile, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const raw = JSON.parse(l) as {
        to: { address: string }[] | { address: string };
        subject: string;
        text: string;
      };
      const to = Array.isArray(raw.to) ? raw.to[0].address : raw.to.address;
      return { to, subject: raw.subject, text: raw.text };
    });
}

beforeEach(() => {
  db.prepare("DELETE FROM login_settings").run();
  db.prepare("DELETE FROM login_profiles").run();
  db.prepare("DELETE FROM logins").run();
  // SMTP configured (host+port+from) so isConfigured() can pass; the capture path
  // never touches a relay.
  setSmtpConfig({
    host: "smtp.example.com",
    port: 587,
    user: "",
    from: "allos@example.com",
  });
  setSetting("public_url", "https://allos.example");
  captureFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "allos-email-notify-")),
    "mailbox.jsonl"
  );
  process.env.EMAIL_TEST_CAPTURE = captureFile;
});

afterEach(() => {
  delete process.env.EMAIL_TEST_CAPTURE;
});

describe("resolveEmailRecipients (#1855)", () => {
  it("resolves managing logins with the channel enabled and an address — no admin bypass", () => {
    const kid = newProfile("Kid (email)");
    const caregiver = newLogin("member", "email-caregiver", "care@example.com");
    const admin = newLogin("admin", "email-admin", "admin@example.com");
    grant(caregiver, kid);
    // The admin holds NO grant — an admin who can act as every profile must opt in.
    setLoginEmailNotify(caregiver, {
      emailEnabled: true,
      emailFullContent: false,
    });
    setLoginEmailNotify(admin, { emailEnabled: true, emailFullContent: false });

    expect(resolveEmailRecipients(kid)).toEqual([
      { loginId: caregiver, address: "care@example.com", fullContent: false },
    ]);
  });

  it("excludes a disabled login, a login with no address, and a muted (login, profile) pair", () => {
    const kid = newProfile("Kid 2 (email)");
    const off = newLogin("member", "email-off", "off@example.com");
    const bare = newLogin("member", "email-bare", null);
    const muted = newLogin("member", "email-muted", "muted@example.com");
    for (const l of [off, bare, muted]) grant(l, kid);
    setLoginEmailNotify(bare, { emailEnabled: true, emailFullContent: false });
    setLoginEmailNotify(muted, { emailEnabled: true, emailFullContent: false });
    setProfileMutedForLogin(muted, kid, true);

    expect(resolveEmailRecipients(kid)).toEqual([]);
  });

  it("dedupes a shared address, and the per-kind filter gates each login's own copy", () => {
    const kid = newProfile("Kid 3 (email)");
    // logins.email is unique-if-set NOCASE (migration 064), so an exact/case
    // duplicate can't even be stored — the shared-inbox case that CAN arise is a
    // whitespace/case variant, which the resolution trims and the dedup collapses.
    const a = newLogin("member", "email-a", "family@example.com");
    const b = newLogin("member", "email-b", " Family@example.com ");
    grant(a, kid);
    grant(b, kid);
    // a opted into full content; b (same inbox) did not → content-free wins.
    setLoginEmailNotify(a, { emailEnabled: true, emailFullContent: true });
    setLoginEmailNotify(b, { emailEnabled: true, emailFullContent: false });
    const shared = resolveEmailRecipients(kid);
    expect(shared).toHaveLength(1);
    expect(shared[0].fullContent).toBe(false);

    // b disabling a kind removes only b's copy — and with a's still on, the
    // deduped audience keeps the address.
    setLoginEmailDisabledKinds(b, ["refill"]);
    expect(resolveEmailRecipients(kid, "refill")).toHaveLength(1);
    // Both off → nobody.
    setLoginEmailDisabledKinds(a, ["refill"]);
    expect(resolveEmailRecipients(kid, "refill")).toEqual([]);
    // A safety kind is untouched by the refill column.
    expect(resolveEmailRecipients(kid, "escalation")).toHaveLength(1);
  });
});

describe("emailChannel.send end-to-end (capture)", () => {
  it("the content-free DEFAULT strips the message: no medication name reaches the mail", async () => {
    const kid = newProfile("Kid 4 (email)");
    const caregiver = newLogin("member", "email-free", "free@example.com");
    grant(caregiver, kid);
    // Enabled with the DEFAULT mode (content-free) — no full_content write at all.
    setLoginEmailNotify(caregiver, {
      emailEnabled: true,
      emailFullContent: false,
    });

    expect(emailChannel.isConfigured(kid)).toBe(true);
    await emailChannel.send(kid, {
      title: "[Kid 4] Medication reminder",
      body: "Take 2 × Examplomab 50 mg with food.",
      kind: "dose",
    });

    const mails = capturedMails();
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("free@example.com");
    const rendered = `${mails[0].subject}\n${mails[0].text}`;
    expect(rendered).not.toContain("Examplomab");
    expect(rendered).not.toContain("Kid 4");
    // The nudge still points home.
    expect(mails[0].text).toContain("https://allos.example");
  });

  it("a full-content login gets the message words; safety kinds deliver like any other", async () => {
    const kid = newProfile("Kid 5 (email)");
    const caregiver = newLogin("member", "email-full", "full@example.com");
    grant(caregiver, kid);
    setLoginEmailNotify(caregiver, {
      emailEnabled: true,
      emailFullContent: true,
    });

    await emailChannel.send(kid, {
      title: "[Kid 5] Missed dose",
      body: "Examplomab — morning slot, unconfirmed for 2h.",
      kind: "escalation",
    });

    const mails = capturedMails();
    expect(mails).toHaveLength(1);
    expect(mails[0].subject).toBe("[Kid 5] Missed dose");
    expect(mails[0].text).toContain("unconfirmed for 2h");
  });

  it("a button-only kind and a fully kind-filtered audience are no-op successes", async () => {
    const kid = newProfile("Kid 6 (email)");
    const caregiver = newLogin("member", "email-noop", "noop@example.com");
    grant(caregiver, kid);
    setLoginEmailNotify(caregiver, {
      emailEnabled: true,
      emailFullContent: false,
    });

    // Button-only kind → skipped, never a throw.
    await emailChannel.send(kid, {
      title: "Food nudge",
      body: "Tap what you've eaten.",
      kind: "food",
    });
    // Kind disabled for the only recipient → no send, no throw.
    setLoginEmailDisabledKinds(caregiver, ["digest"]);
    await emailChannel.send(kid, {
      title: "Digest",
      body: "Morning digest.",
      kind: "digest",
    });
    expect(capturedMails()).toEqual([]);
  });

  it("isConfigured is false without SMTP even when recipients exist", () => {
    const kid = newProfile("Kid 7 (email)");
    const caregiver = newLogin("member", "email-cfg", "cfg@example.com");
    grant(caregiver, kid);
    setLoginEmailNotify(caregiver, {
      emailEnabled: true,
      emailFullContent: false,
    });
    setSmtpConfig({ host: "", port: 587, user: "", from: "" });
    expect(emailChannel.isConfigured(kid)).toBe(false);
  });
});

describe("sendTestEmailToLogin", () => {
  it("returns typed refusals and sends to the login's own address when wired", async () => {
    const login = newLogin("member", "email-test", null);
    expect(await sendTestEmailToLogin(login)).toBe("no-address");

    db.prepare("UPDATE logins SET email = ? WHERE id = ?").run(
      "self@example.com",
      login
    );
    expect(await sendTestEmailToLogin(login)).toBe("sent");
    const mails = capturedMails();
    expect(mails).toHaveLength(1);
    expect(mails[0].to).toBe("self@example.com");

    setSmtpConfig({ host: "", port: 587, user: "", from: "" });
    expect(await sendTestEmailToLogin(login)).toBe("not-configured");
  });
});
