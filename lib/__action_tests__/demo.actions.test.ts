// SERVER-ACTION TIER — demo-mode write refusal (#181) and the login-scoped
// account-management guard (#278).
//
// In a public demo (ALLOS_DEMO_MODE set) a non-admin write must be refused at the
// requireWriteAccess() boundary regardless of the grant. The auth mock (setup.ts)
// applies the SAME pure predicate (isDemoRestricted) the real guard does, so this
// drives a real write action through it: a demo member's write throws and lands NO
// row, while the admin (and the same member with the flag off) still writes.
//
// #278 extends the same posture to LOGIN-scoped auth mutations via
// requireLoginWriteAccess(): 2FA enrollment, change-own-password, and session
// revocation on the SHARED demo login would lock every other visitor out, so all
// five must refuse server-side while the admin (and a flag-off member) keep them.

import { describe, it, expect, afterEach } from "vitest";
import { db } from "@/lib/db";
import { addBodyMetric } from "@/app/(app)/trends/body-actions";
import {
  begin2fa,
  activate2fa,
  changeOwnPassword,
  revokeSessionAction,
  signOutOtherSessions,
} from "@/app/(app)/settings/actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

function rowsFor(profileId: number) {
  return db
    .prepare("SELECT id FROM body_metrics WHERE profile_id = ?")
    .all(profileId) as { id: number }[];
}

afterEach(() => {
  // process.env is shared across the worker — always clear so a later file isn't
  // silently left in demo mode.
  delete process.env.ALLOS_DEMO_MODE;
});

describe("demo mode write guard", () => {
  it("refuses a non-admin (member) write and writes no row", async () => {
    process.env.ALLOS_DEMO_MODE = "1";
    const login = createLogin({ role: "member" });
    const profile = createProfile("demo-member", login.id); // read grant not even needed
    actAs(login, profile, "write"); // even a (misconfigured) write grant is blocked

    await expect(
      addBodyMetric(fd({ date: "2026-02-01", weight: 80 }))
    ).rejects.toThrow(/demo mode/i);

    expect(rowsFor(profile.id)).toHaveLength(0);
  });

  it("still lets an admin write in demo mode (operator stays functional)", async () => {
    process.env.ALLOS_DEMO_MODE = "1";
    const login = createLogin({ role: "admin", weightUnit: "kg" });
    const profile = createProfile("demo-admin");
    actAs(login, profile, "write");

    await addBodyMetric(fd({ date: "2026-02-02", weight: 81 }));

    expect(rowsFor(profile.id)).toHaveLength(1);
  });

  it("lets the same member write when the flag is OFF (no behavior change by default)", async () => {
    // No ALLOS_DEMO_MODE set.
    const login = createLogin({ role: "member", weightUnit: "kg" });
    const profile = createProfile("normal-member", login.id);
    actAs(login, profile, "write");

    await addBodyMetric(fd({ date: "2026-02-03", weight: 82 }));

    expect(rowsFor(profile.id)).toHaveLength(1);
  });
});

// #278: the login-scoped account-management actions (2FA enrollment, change own
// password, session revocation) route through requireLoginWriteAccess — a demo
// member is refused with NO login-state change, so a visitor to the shared demo
// login can't lock everyone else out.
describe("demo mode login-scoped guard (#278)", () => {
  function loginRow(id: number) {
    return db
      .prepare(
        "SELECT password_hash, totp_secret, totp_enabled FROM logins WHERE id = ?"
      )
      .get(id) as {
      password_hash: string;
      totp_secret: string | null;
      totp_enabled: number;
    };
  }

  it("refuses all five account-management actions for a demo member and mutates nothing", async () => {
    process.env.ALLOS_DEMO_MODE = "1";
    const login = createLogin({ role: "member" });
    const profile = createProfile("demo-member-login-scope", login.id);
    actAs(login, profile, "write");
    const before = loginRow(login.id);

    await expect(begin2fa()).rejects.toThrow(/demo mode/i);
    await expect(activate2fa(fd({ code: "000000" }))).rejects.toThrow(
      /demo mode/i
    );
    await expect(
      changeOwnPassword(
        fd({
          current_password: "pw-" + login.username,
          new_password: "correct-Horse-battery-9",
        })
      )
    ).rejects.toThrow(/demo mode/i);
    await expect(
      revokeSessionAction(fd({ session_id: "any-session-id" }))
    ).rejects.toThrow(/demo mode/i);
    await expect(signOutOtherSessions()).rejects.toThrow(/demo mode/i);

    // Nothing about the login's auth state moved: no pending TOTP secret was
    // minted, 2FA stayed off, and the (publicly documented) password is intact.
    expect(loginRow(login.id)).toEqual(before);
  });

  it("still lets an admin enroll 2FA in demo mode (operator stays functional)", async () => {
    process.env.ALLOS_DEMO_MODE = "1";
    const login = createLogin({ role: "admin" });
    const profile = createProfile("demo-admin-login-scope");
    actAs(login, profile, "write");

    const res = await begin2fa();
    expect(res.ok).toBe(true);
    // The pending (not yet enforced) secret landed on the real row.
    const row = loginRow(login.id);
    expect(row.totp_secret).not.toBeNull();
    expect(row.totp_enabled).toBe(0);
  });

  it("lets a member start 2FA enrollment when the flag is OFF (no behavior change by default)", async () => {
    // No ALLOS_DEMO_MODE set.
    const login = createLogin({ role: "member" });
    const profile = createProfile("normal-member-login-scope", login.id);
    actAs(login, profile, "write");

    const res = await begin2fa();
    expect(res.ok).toBe(true);
    expect(loginRow(login.id).totp_secret).not.toBeNull();
  });
});
