// SERVER-ACTION TIER — the own-profile association write paths (issue #1013):
//   • saveOwnProfile (Preferences, login-scoped): a login sets/clears its OWN
//     own-profile, constrained to its accessible profiles (an ungranted id is
//     refused; null clears);
//   • setLoginOwnProfile (Family, admin-only): an admin sets a login's own-profile,
//     same accessibility constraint;
//   • row-side-state: revoking the grant that made a profile a member's own-profile
//     nulls the association (setGrants), and deleting a profile nulls every login
//     pointing at it (deleteProfile).

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import { saveOwnProfile } from "@/app/(app)/settings/actions";
import {
  setLoginOwnProfile,
  setGrants,
  deleteProfile,
} from "@/app/(app)/settings/family/actions";
import { grantSignature } from "@/lib/grants";
import { createLogin, createProfile, actAs } from "./harness";

function ownOf(loginId: number): number | null {
  const row = db
    .prepare("SELECT own_profile_id AS o FROM logins WHERE id = ?")
    .get(loginId) as { o: number | null } | undefined;
  return row?.o ?? null;
}
function grant(loginId: number, profileId: number): void {
  db.prepare(
    "INSERT OR IGNORE INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
  ).run(loginId, profileId);
}
function ownForm(v: number | "none"): FormData {
  const f = new FormData();
  f.set("own_profile_id", String(v));
  return f;
}
function loginOwnForm(loginId: number, v: number | "none"): FormData {
  const f = new FormData();
  f.set("loginId", String(loginId));
  f.set("own_profile_id", String(v));
  return f;
}

describe("saveOwnProfile (Preferences, login-scoped)", () => {
  it("a member sets its own-profile to a GRANTED profile", async () => {
    const member = createLogin({ role: "member" });
    const mine = createProfile("Mine", member.id);
    actAs(member, mine, "write");
    const res = await saveOwnProfile(ownForm(mine.id));
    expect(res.ok).toBe(true);
    expect(ownOf(member.id)).toBe(mine.id);
  });

  it("a member CANNOT set an ungranted profile as its own (refused, no write)", async () => {
    const member = createLogin({ role: "member" });
    const mine = createProfile("Mine", member.id);
    const other = createProfile("Someone Else"); // NOT granted
    actAs(member, mine, "write");
    const res = await saveOwnProfile(ownForm(other.id));
    expect(res.ok).toBe(false);
    expect(ownOf(member.id)).toBeNull();
  });

  it("clears the association with 'none'", async () => {
    const member = createLogin({ role: "member" });
    const mine = createProfile("Mine", member.id);
    actAs(member, mine, "write");
    await saveOwnProfile(ownForm(mine.id));
    const res = await saveOwnProfile(ownForm("none"));
    expect(res.ok).toBe(true);
    expect(ownOf(member.id)).toBeNull();
  });
});

describe("setLoginOwnProfile (Family, admin-only)", () => {
  let admin: ReturnType<typeof createLogin>;
  beforeEach(() => {
    admin = createLogin({ role: "admin" });
    const home = createProfile("Admin Home");
    actAs(admin, home);
  });

  it("an admin sets a member's own-profile to a profile the member is granted", async () => {
    const member = createLogin({ role: "member" });
    const mine = createProfile("Member Mine", member.id);
    const res = await setLoginOwnProfile(loginOwnForm(member.id, mine.id));
    expect(res.ok).toBe(true);
    expect(ownOf(member.id)).toBe(mine.id);
  });

  it("an admin CANNOT set a member's own-profile to an ungranted profile", async () => {
    const member = createLogin({ role: "member" });
    createProfile("Member Mine", member.id);
    const ungranted = createProfile("Not Theirs");
    const res = await setLoginOwnProfile(loginOwnForm(member.id, ungranted.id));
    expect(res.ok).toBe(false);
    expect(ownOf(member.id)).toBeNull();
  });

  it("an admin may set ANY profile as another ADMIN's own (implicit all-access)", async () => {
    const other = createLogin({ role: "admin" });
    const anyProfile = createProfile("Any Profile");
    const res = await setLoginOwnProfile(loginOwnForm(other.id, anyProfile.id));
    expect(res.ok).toBe(true);
    expect(ownOf(other.id)).toBe(anyProfile.id);
  });
});

describe("row-side-state nulling", () => {
  it("revoking the own-profile grant nulls the association (setGrants)", async () => {
    const admin = createLogin({ role: "admin" });
    actAs(admin, createProfile("Home"));
    const member = createLogin({ role: "member" });
    const a = createProfile("A", member.id);
    const b = createProfile("B", member.id);
    // Member's own-profile is A.
    db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
      a.id,
      member.id
    );
    // Admin re-saves the grant set WITHOUT A (revoking it), keeping B.
    const snapshot = grantSignature([
      { profileId: a.id, access: "write" },
      { profileId: b.id, access: "write" },
    ]);
    const f = new FormData();
    f.set("loginId", String(member.id));
    f.set("grants_snapshot", snapshot);
    f.append("profileId", String(b.id));
    f.set(`access_${b.id}`, "write");
    const res = await setGrants(f);
    expect(res.ok).toBe(true);
    expect(ownOf(member.id)).toBeNull();
  });

  it("deleting a profile nulls every login pointing at it (deleteProfile)", async () => {
    const admin = createLogin({ role: "admin" });
    actAs(admin, createProfile("Home"));
    const member = createLogin({ role: "member" });
    const victim = createProfile("Victim", member.id);
    // Keep at least one other profile so deleteProfile isn't refused as "the last".
    createProfile("Survivor", member.id);
    grant(member.id, victim.id);
    db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
      victim.id,
      member.id
    );
    const f = new FormData();
    f.set("id", String(victim.id));
    f.set("confirm_name", "Victim");
    const res = await deleteProfile(f);
    expect(res.ok).toBe(true);
    expect(ownOf(member.id)).toBeNull();
  });
});
