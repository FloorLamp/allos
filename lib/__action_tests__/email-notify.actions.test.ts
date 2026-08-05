// SERVER-ACTION TIER — the email delivery channel's login-scoped actions (#1855).
// Proves the enable + content-mode save persists to the ACTING login's tier store
// (and to nobody else's), that the content mode defaults to content-free and is
// widened ONLY by the form field carrying the user's own tap, that the matrix
// column mirrors the Telegram/push columns, and that the send-test answers from a
// typed outcome — never an unconditional confirm.

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { revalidatePath } from "next/cache";
import {
  saveLoginEmailNotify,
  saveLoginEmailNotifyKinds,
  sendTestEmailNotification,
} from "@/app/(app)/settings/actions";
import {
  getLoginEmailNotify,
  getLoginEmailDisabledKinds,
  setSmtpConfig,
} from "@/lib/settings";
import { db } from "@/lib/db";
import { createLogin, createProfile, actAs, fd } from "./harness";

const revalidate = vi.mocked(revalidatePath);

let captureFile: string;

beforeEach(() => {
  revalidate.mockClear();
  setSmtpConfig({
    host: "smtp.example.com",
    port: 587,
    user: "",
    from: "allos@example.com",
  });
  captureFile = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), "allos-email-actions-")),
    "mailbox.jsonl"
  );
  process.env.EMAIL_TEST_CAPTURE = captureFile;
});

afterEach(() => {
  delete process.env.EMAIL_TEST_CAPTURE;
});

describe("saveLoginEmailNotify (login tier, #1855)", () => {
  it("persists enable + content mode to the acting login only", async () => {
    const login = createLogin();
    const profile = createProfile("email-owner", login.id);
    const other = createLogin();
    actAs(login, profile);

    const res = await saveLoginEmailNotify(
      fd({ email_enabled: "1", email_full_content: "1" })
    );
    expect(res).toEqual({ ok: true });
    expect(getLoginEmailNotify(login.id)).toEqual({
      emailEnabled: true,
      emailFullContent: true,
    });
    expect(getLoginEmailNotify(other.id)).toEqual({
      emailEnabled: false,
      emailFullContent: false,
    });
    expect(revalidate).toHaveBeenCalledWith("/settings/notifications");
  });

  it("defaults to content-free: an absent mode field never widens the stored choice", async () => {
    const login = createLogin();
    const profile = createProfile("email-default", login.id);
    actAs(login, profile);

    await saveLoginEmailNotify(fd({ email_enabled: "1" }));
    expect(getLoginEmailNotify(login.id)).toEqual({
      emailEnabled: true,
      emailFullContent: false,
    });

    // And an explicit save back to content-free narrows a widened login.
    await saveLoginEmailNotify(
      fd({ email_enabled: "1", email_full_content: "1" })
    );
    await saveLoginEmailNotify(
      fd({ email_enabled: "1", email_full_content: "0" })
    );
    expect(getLoginEmailNotify(login.id).emailFullContent).toBe(false);
  });

  it("is allowed for a read-only member (login-scoped, not profile-owned)", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("email-ro", login.id);
    actAs(login, profile, "read");
    const res = await saveLoginEmailNotify(fd({ email_enabled: "1" }));
    expect(res).toEqual({ ok: true });
    expect(getLoginEmailNotify(login.id).emailEnabled).toBe(true);
  });
});

describe("saveLoginEmailNotifyKinds (login tier, #1855)", () => {
  it("persists the email column to the acting login and drops unknown kinds", async () => {
    const login = createLogin();
    const profile = createProfile("email-kinds", login.id);
    const other = createLogin();
    actAs(login, profile);

    const res = await saveLoginEmailNotifyKinds(
      fd({ disabled_kinds: JSON.stringify(["refill", "not-a-kind"]) })
    );
    expect(res).toEqual({ ok: true });
    expect(getLoginEmailDisabledKinds(login.id)).toEqual(["refill"]);
    expect(getLoginEmailDisabledKinds(other.id)).toEqual([]);
  });
});

describe("sendTestEmailNotification (typed outcomes, #1855)", () => {
  it("refuses honestly without an address, then sends to the login's own address", async () => {
    const login = createLogin();
    const profile = createProfile("email-send", login.id);
    actAs(login, profile);

    const noAddress = await sendTestEmailNotification();
    expect(noAddress.ok).toBe(false);
    expect(noAddress.message).toMatch(/no email address/i);

    db.prepare("UPDATE logins SET email = ? WHERE id = ?").run(
      "tester@example.com",
      login.id
    );
    const sent = await sendTestEmailNotification();
    expect(sent.ok).toBe(true);
    expect(fs.readFileSync(captureFile, "utf8")).toContain(
      "tester@example.com"
    );
  });

  it("refuses honestly when SMTP is unconfigured", async () => {
    const login = createLogin();
    const profile = createProfile("email-nosmtp", login.id);
    actAs(login, profile);
    setSmtpConfig({ host: "", port: 587, user: "", from: "" });
    const res = await sendTestEmailNotification();
    expect(res.ok).toBe(false);
    expect(res.message).toMatch(/mail server/i);
  });
});
