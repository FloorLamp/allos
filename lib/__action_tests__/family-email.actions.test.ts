// SERVER-ACTION TIER — the Family login-email + invite actions (issue #985).
// Admin-gated, so they run under the shared setup mock (requireAdmin → acting
// session). Email sends are captured to a file via EMAIL_TEST_CAPTURE (no network).

import { describe, it, expect, beforeEach, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import {
  createLogin,
  sendInvite,
  setLoginEmail,
} from "@/app/(app)/settings/family/actions";
import { setSmtpConfig, setPublicUrl } from "@/lib/settings";
import { createLogin as seedLogin, createProfile, actAs, fd } from "./harness";

const captureFile = path.join(
  os.tmpdir(),
  `allos-mail-family-${process.pid}-${Date.now()}.jsonl`
);

// A strong password that passes checkPasswordStrength.
const STRONG = "Zt7-mln-Qp9x!";

function captured(): string {
  return fs.readFileSync(captureFile, "utf8");
}

beforeEach(() => {
  db.prepare("DELETE FROM login_auth_tokens").run();
  fs.writeFileSync(captureFile, "");
  process.env.EMAIL_TEST_CAPTURE = captureFile;
  setSmtpConfig({
    host: "smtp.example.com",
    port: 587,
    user: "",
    from: "allos@example.com",
  });
  setPublicUrl("https://app.example.com");
  const admin = seedLogin({ role: "admin" });
  const profile = createProfile("Admin Home");
  actAs(admin, profile);
});

afterAll(() => {
  try {
    fs.rmSync(captureFile, { force: true });
  } catch {
    // throwaway
  }
  delete process.env.EMAIL_TEST_CAPTURE;
});

describe("createLogin with email + invite (#985)", () => {
  it("creates the login, mints an invite token, and emails a set-password link", async () => {
    const res = await createLogin(
      fd({
        username: "newbie",
        password: STRONG,
        role: "member",
        email: "newbie@example.com",
        invite: "1",
      })
    );
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.message).toMatch(/sent an invite/i);

    const login = db
      .prepare("SELECT id, email FROM logins WHERE username = 'newbie'")
      .get() as { id: number; email: string };
    expect(login.email).toBe("newbie@example.com");
    const tok = db
      .prepare("SELECT kind FROM login_auth_tokens WHERE login_id = ?")
      .get(login.id) as { kind: string } | undefined;
    expect(tok?.kind).toBe("invite");

    const mail = captured();
    expect(mail).toContain("newbie@example.com");
    expect(mail).toContain("/set-password?token=");
  });

  it("rejects an invalid email without creating the login", async () => {
    const res = await createLogin(
      fd({ username: "bad", password: STRONG, email: "not-an-email" })
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/valid email/i);
    const row = db
      .prepare("SELECT id FROM logins WHERE username = 'bad'")
      .get();
    expect(row).toBeUndefined();
  });

  it("rejects a duplicate email (unique-if-set NOCASE)", async () => {
    await createLogin(
      fd({ username: "first", password: STRONG, email: "dup@example.com" })
    );
    const res = await createLogin(
      fd({ username: "second", password: STRONG, email: "DUP@example.com" })
    );
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/already in use/i);
  });
});

describe("sendInvite + setLoginEmail (#985)", () => {
  it("emails an invite to an existing login with an email", async () => {
    const created = await createLogin(
      fd({ username: "later", password: STRONG, email: "later@example.com" })
    );
    expect(created.ok).toBe(true);
    fs.writeFileSync(captureFile, ""); // clear — no invite sent on create
    const id = (
      db.prepare("SELECT id FROM logins WHERE username = 'later'").get() as {
        id: number;
      }
    ).id;

    const res = await sendInvite(fd({ id }));
    expect(res.ok).toBe(true);
    expect(captured()).toContain("later@example.com");
    expect(captured()).toContain("/set-password?token=");
  });

  it("refuses to invite a login with no email", async () => {
    await createLogin(fd({ username: "noemail", password: STRONG }));
    const id = (
      db.prepare("SELECT id FROM logins WHERE username = 'noemail'").get() as {
        id: number;
      }
    ).id;
    const res = await sendInvite(fd({ id }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/add an email/i);
  });

  it("refuses to invite when the public URL is unset (honest copy)", async () => {
    setPublicUrl("");
    const created = await createLogin(
      fd({ username: "nourl", password: STRONG, email: "nourl@example.com" })
    );
    expect(created.ok).toBe(true);
    const id = (
      db.prepare("SELECT id FROM logins WHERE username = 'nourl'").get() as {
        id: number;
      }
    ).id;
    const res = await sendInvite(fd({ id }));
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/public app URL/i);
  });

  it("setLoginEmail sets and clears the address", async () => {
    await createLogin(fd({ username: "edit", password: STRONG }));
    const id = (
      db.prepare("SELECT id FROM logins WHERE username = 'edit'").get() as {
        id: number;
      }
    ).id;

    const set = await setLoginEmail(fd({ id, email: "edit@example.com" }));
    expect(set.ok).toBe(true);
    expect(
      (
        db.prepare("SELECT email FROM logins WHERE id = ?").get(id) as {
          email: string | null;
        }
      ).email
    ).toBe("edit@example.com");

    const clear = await setLoginEmail(fd({ id, email: "" }));
    expect(clear.ok).toBe(true);
    expect(
      (
        db.prepare("SELECT email FROM logins WHERE id = ?").get(id) as {
          email: string | null;
        }
      ).email
    ).toBeNull();
  });
});
