// SERVER-ACTION TIER — creating a login through Settings → Family (issue #1434).
//
// Two hardenings of the invite journey live in createLogin, and both are only
// visible at this tier (the rows the action actually writes):
//
//  1. PASSWORDLESS INVITE. With "email an invite" checked, no password is asked for
//     or accepted: the login is created with a credential nobody knows, so it is
//     unusable until the invitee spends their token — instead of the admin-invented
//     interim password that used to stay valid alongside the invite link.
//  2. INITIAL ACCESS. The create form now carries the member's first profile grants,
//     so the happy path can't produce the grantless dead-end. The submitted ids are
//     re-validated server-side (a forged id is dropped) and ignored for an admin,
//     who is implicit-all.

import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { db } from "@/lib/db";
import { createLogin as createLoginAction } from "@/app/(app)/settings/family/actions";
import { verifyPassword } from "@/lib/password";
import { setSmtpConfig, setPublicUrl } from "@/lib/settings";
import { createLogin, createProfile, actAs } from "./harness";

const captureFile = path.join(
  os.tmpdir(),
  `allos-mail-invite-${process.pid}-${Date.now()}.jsonl`
);
const STRONG = "Zt7-mln-Qp9x!";

let seq = 0;
function form(fields: Record<string, string>, grants: number[] = []): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) f.set(k, v);
  for (const id of grants) {
    f.append("profileId", String(id));
    f.set(`access_${id}`, "write");
  }
  return f;
}

function loginRow(username: string) {
  return db
    .prepare("SELECT id, password_hash FROM logins WHERE username = ?")
    .get(username) as { id: number; password_hash: string } | undefined;
}

function grantsFor(loginId: number): { profileId: number; access: string }[] {
  return db
    .prepare(
      "SELECT profile_id AS profileId, access FROM login_profiles WHERE login_id = ? ORDER BY profile_id"
    )
    .all(loginId) as { profileId: number; access: string }[];
}

beforeEach(() => {
  fs.writeFileSync(captureFile, "");
  process.env.EMAIL_TEST_CAPTURE = captureFile;
  setSmtpConfig({
    host: "smtp.example.com",
    port: 587,
    user: "",
    from: "allos@example.com",
  });
  setPublicUrl("https://app.example.com");
  actAs(createLogin({ role: "admin" }), createProfile("Admin Home"));
});

afterAll(() => {
  try {
    fs.rmSync(captureFile, { force: true });
  } catch {
    // throwaway
  }
});

describe("createLogin — the invite carries the credential (#1434)", () => {
  it("creates a PASSWORDLESS login when an invite is emailed", async () => {
    const username = `invitee_${++seq}`;
    const res = await createLoginAction(
      form({
        username,
        password: "", // the form disables the field; the action must not need it
        role: "member",
        email: `${username}@example.com`,
        invite: "1",
      })
    );
    expect(res.ok).toBe(true);

    const row = loginRow(username);
    expect(row).toBeTruthy();
    // A real stored hash (the column is NOT NULL) — of a value nobody knows, so
    // neither the empty string nor any obvious placeholder signs in.
    expect(row!.password_hash).toMatch(/^scrypt\$/);
    for (const guess of ["", " ", username, "password", "invite"]) {
      expect(await verifyPassword(guess, row!.password_hash)).toBe(false);
    }
    // The invite really went out — the login is claimable.
    expect(fs.readFileSync(captureFile, "utf8")).toContain("set-password");
  });

  it("still demands a real password when no invite is sent", async () => {
    const username = `weak_${++seq}`;
    const res = await createLoginAction(
      form({ username, password: "short", role: "member" })
    );
    expect(res.ok).toBe(false);
    expect(loginRow(username)).toBeUndefined();
  });

  it("refuses the invite path — creating nothing — when the instance can't send", async () => {
    setPublicUrl("");
    const username = `unsendable_${++seq}`;
    const res = await createLoginAction(
      form({
        username,
        password: "",
        role: "member",
        email: `${username}@example.com`,
        invite: "1",
      })
    );
    expect(res.ok).toBe(false);
    // No login left behind with a credential nobody can ever claim.
    expect(loginRow(username)).toBeUndefined();
  });

  it("refuses an invite with no email address, creating nothing", async () => {
    const username = `noemail_${++seq}`;
    const res = await createLoginAction(
      form({ username, password: "", role: "member", invite: "1" })
    );
    expect(res.ok).toBe(false);
    expect(loginRow(username)).toBeUndefined();
  });
});

describe("createLogin — initial profile access (#1434)", () => {
  it("grants the selected profiles atomically with the login", async () => {
    const p1 = createProfile("Access One");
    const p2 = createProfile("Access Two");
    const username = `granted_${++seq}`;
    const res = await createLoginAction(
      form({ username, password: STRONG, role: "member" }, [p1.id, p2.id])
    );
    expect(res.ok).toBe(true);
    const row = loginRow(username)!;
    expect(grantsFor(row.id)).toEqual([
      { profileId: p1.id, access: "write" },
      { profileId: p2.id, access: "write" },
    ]);
  });

  it("drops a forged profile id instead of granting it", async () => {
    const p1 = createProfile("Access Real");
    const username = `forged_${++seq}`;
    const res = await createLoginAction(
      form({ username, password: STRONG, role: "member" }, [p1.id, 999_999])
    );
    expect(res.ok).toBe(true);
    expect(grantsFor(loginRow(username)!.id)).toEqual([
      { profileId: p1.id, access: "write" },
    ]);
  });

  it("keeps an ADMIN's selection as its notification scope (#2345)", async () => {
    // This selection used to be DISCARDED ("admins are implicit-all"), which is true
    // about access and irrelevant to notifications: the fan-out excludes the admin
    // role, so an admin with no row receives nothing about anyone. The row is now
    // kept, at the inert 'write' the column has no readers for.
    const p1 = createProfile("Access Admin");
    const username = `adminsel_${++seq}`;
    const res = await createLoginAction(
      form({ username, password: STRONG, role: "admin" }, [p1.id])
    );
    expect(res.ok).toBe(true);
    expect(grantsFor(loginRow(username)!.id)).toEqual([
      { profileId: p1.id, access: "write" },
    ]);
  });

  it("still creates an ADMIN with no rows when none were selected (#2345)", async () => {
    // Opt-IN stays opt-in: nothing is chosen for them, on creation or ever.
    const username = `adminbare_${++seq}`;
    const res = await createLoginAction(
      form({ username, password: STRONG, role: "admin" })
    );
    expect(res.ok).toBe(true);
    expect(grantsFor(loginRow(username)!.id)).toEqual([]);
  });

  it("still allows a deliberately grantless member, and says so", async () => {
    const username = `nogrant_${++seq}`;
    const res = await createLoginAction(
      form({ username, password: STRONG, role: "member" })
    );
    expect(res.ok).toBe(true);
    expect(grantsFor(loginRow(username)!.id)).toEqual([]);
    // The admin is told the login can't sign in usefully yet — the old copy said
    // only "Grant it a profile below".
    expect(res.ok && res.message).toMatch(/can’t sign in usefully/);
  });
});
