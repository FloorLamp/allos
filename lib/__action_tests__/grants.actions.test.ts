// SERVER-ACTION TIER — the family grant matrix (setGrants), issue #467.
//
// setGrants' DESIRED set is absolute, so a stale admin form (opened before another
// admin granted profile P to a member) would diff "remove P" and silently revoke the
// fresh grant. The action now takes an optimistic-concurrency snapshot: the form
// submits the signature of the grants it LOADED with, and the action re-reads the
// login's CURRENT grants under the IMMEDIATE write lock and REFUSES (friendly reload)
// when they differ — holding another admin's fresh grant intact.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  createLogin as createLoginAction,
  setGrants,
} from "@/app/(app)/settings/family/actions";
import { accessForProfile, accessibleProfilesForLogin } from "@/lib/auth";
import { managingLoginIdsForProfile } from "@/lib/notifications/fan-out";
import { grantSignature, type Access } from "@/lib/grants";
import { createLogin, createProfile, actAs } from "./harness";
import { ACTION_TEST_PASSWORD } from "./password-fixture";

function grantsForm(
  loginId: number,
  desired: { id: number; access: Access }[],
  snapshot: string
): FormData {
  const f = new FormData();
  f.set("loginId", String(loginId));
  f.set("grants_snapshot", snapshot);
  for (const g of desired) {
    f.append("profileId", String(g.id));
    f.set(`access_${g.id}`, g.access);
  }
  return f;
}

function currentGrants(
  loginId: number
): { profileId: number; access: Access }[] {
  return (
    db
      .prepare(
        "SELECT profile_id AS profileId, access FROM login_profiles WHERE login_id = ? ORDER BY profile_id"
      )
      .all(loginId) as { profileId: number; access: string | null }[]
  ).map((r) => ({
    profileId: r.profileId,
    access: (r.access === "read" ? "read" : "write") as Access,
  }));
}

describe("setGrants optimistic concurrency (issue #467)", () => {
  let member: ReturnType<typeof createLogin>;
  let p1: ReturnType<typeof createProfile>;
  let p2: ReturnType<typeof createProfile>;

  beforeEach(() => {
    // Act as an admin (the grant screen is admin-only). The two admins in the story
    // share this same acting identity — what matters is the FORM's loaded snapshot.
    const admin = createLogin({ role: "admin" });
    const adminProfile = createProfile("Admin Home");
    actAs(admin, adminProfile);

    member = createLogin({ role: "member" });
    p1 = createProfile("Profile One");
    p2 = createProfile("Profile Two");
    // The member starts with exactly P1:write.
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(member.id, p1.id);
  });

  it("refuses a stale save and preserves another admin's fresh grant", async () => {
    // Admin B loaded the form when the member had only P1:write.
    const staleSnapshot = grantSignature([
      { profileId: p1.id, access: "write" },
    ]);

    // Meanwhile, Admin A grants P2:write to the member (a concurrent change).
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(member.id, p2.id);

    // Admin B submits its stale desired set (still just P1) with the stale snapshot.
    // Under the old absolute-diff behavior this would compute "remove P2".
    const res = await setGrants(
      grantsForm(member.id, [{ id: p1.id, access: "write" }], staleSnapshot)
    );

    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ ok: false });
    if (!res.ok) expect(res.error.toLowerCase()).toContain("reload");
    // P2 survives — the fresh grant was NOT revoked.
    expect(currentGrants(member.id)).toEqual([
      { profileId: p1.id, access: "write" },
      { profileId: p2.id, access: "write" },
    ]);
  });

  it("applies the diff when the snapshot matches current state", async () => {
    const snapshot = grantSignature([{ profileId: p1.id, access: "write" }]);
    const res = await setGrants(
      grantsForm(
        member.id,
        [
          { id: p1.id, access: "read" }, // level change
          { id: p2.id, access: "write" }, // add
        ],
        snapshot
      )
    );
    expect(res.ok).toBe(true);
    expect(currentGrants(member.id)).toEqual([
      { profileId: p1.id, access: "read" },
      { profileId: p2.id, access: "write" },
    ]);
  });

  it("reports no changes for a matching snapshot with an identical desired set", async () => {
    const snapshot = grantSignature([{ profileId: p1.id, access: "write" }]);
    const res = await setGrants(
      grantsForm(member.id, [{ id: p1.id, access: "write" }], snapshot)
    );
    expect(res).toEqual({ ok: true, message: "No changes." });
    expect(currentGrants(member.id)).toEqual([
      { profileId: p1.id, access: "write" },
    ]);
  });
});

// ---- The admin notification opt-in (issue #2345) ----
//
// `lib/notifications/fan-out.ts` excludes the admin ROLE from the recipient set on
// purpose — a notification is a push into someone's pocket, not a read — and states
// that an admin opts specific profiles back in by GRANTING THEMSELVES. setGrants
// refused every admin ("Admins already have access to every profile"), which is true
// about ACCESS and irrelevant to notification scope, so the opt-in the policy names
// could not be performed at all: on a single-admin instance every profile but their
// own delivered nothing, indefinitely, including the `must` tier.
//
// The regression these pin is that the write now lands AND reaches the fan-out, while
// the row stays provably inert for what an admin can actually see.
describe("setGrants performs an admin's notification opt-in (#2345)", () => {
  let adminTarget: ReturnType<typeof createLogin>;
  let ward: ReturnType<typeof createProfile>;
  let other: ReturnType<typeof createProfile>;

  beforeEach(() => {
    const actor = createLogin({ role: "admin" });
    const actorProfile = createProfile("Acting Admin Home");
    actAs(actor, actorProfile);

    // The login being edited is itself an admin — the case that used to be refused.
    adminTarget = createLogin({ role: "admin" });
    ward = createProfile("Ward Wilhelmina");
    other = createProfile("Other Oona");
  });

  it("writes the row, and the fan-out's managing set then includes that admin", async () => {
    // Today's state: no row, so a per-profile event reaches this admin's channels
    // never — the exact shape that froze three profiles' delivery for weeks.
    expect(managingLoginIdsForProfile(ward.id)).not.toContain(adminTarget.id);

    const res = await setGrants(
      grantsForm(adminTarget.id, [{ id: ward.id, access: "write" }], "")
    );

    expect(res).toEqual({ ok: true, message: "Notifications updated." });
    // The stored level is the inert, non-restricting 'write' every other writer of an
    // admin's row uses — a column default, not a decision.
    expect(currentGrants(adminTarget.id)).toEqual([
      { profileId: ward.id, access: "write" },
    ]);
    // And the ONE edge-set definition the fan-out reads now carries the admin.
    expect(managingLoginIdsForProfile(ward.id)).toContain(adminTarget.id);
  });

  it("unchecking removes the row and drops the admin back out of the set", async () => {
    await setGrants(
      grantsForm(adminTarget.id, [{ id: ward.id, access: "write" }], "")
    );
    const snapshot = grantSignature([{ profileId: ward.id, access: "write" }]);

    const res = await setGrants(grantsForm(adminTarget.id, [], snapshot));

    expect(res.ok).toBe(true);
    expect(currentGrants(adminTarget.id)).toEqual([]);
    expect(managingLoginIdsForProfile(ward.id)).not.toContain(adminTarget.id);
  });

  it("changes NOTHING about what the admin can reach — even from a 'read' row", async () => {
    const before = accessibleProfilesForLogin(adminTarget.id).map((p) => p.id);
    await setGrants(
      grantsForm(adminTarget.id, [{ id: ward.id, access: "write" }], "")
    );

    // Reach is unchanged: an admin already saw every profile, including `other`,
    // which was never granted.
    expect(accessibleProfilesForLogin(adminTarget.id).map((p) => p.id)).toEqual(
      before
    );
    expect(before).toEqual(expect.arrayContaining([ward.id, other.id]));
    expect(accessForProfile(adminTarget.id, "admin", ward.id)).toBe("write");
    expect(accessForProfile(adminTarget.id, "admin", other.id)).toBe("write");

    // The property that makes reusing this table safe: even a hand-written 'read'
    // row (a legacy row, a migration, a direct edit) resolves 'write' for an admin,
    // because the access paths return before they ever read the column.
    db.prepare(
      "UPDATE login_profiles SET access = 'read' WHERE login_id = ? AND profile_id = ?"
    ).run(adminTarget.id, ward.id);
    expect(accessForProfile(adminTarget.id, "admin", ward.id)).toBe("write");
    expect(accessibleProfilesForLogin(adminTarget.id).map((p) => p.id)).toEqual(
      before
    );
    // …and it is still a notification recipient row.
    expect(managingLoginIdsForProfile(ward.id)).toContain(adminTarget.id);
  });

  it("keeps #467's refusal-on-drift for an admin's edit too", async () => {
    // The admin's form loaded with just `ward` checked.
    const staleSnapshot = grantSignature([
      { profileId: ward.id, access: "write" },
    ]);
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(adminTarget.id, ward.id);
    // Meanwhile someone else opted this admin into `other` as well.
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(adminTarget.id, other.id);

    const res = await setGrants(
      grantsForm(
        adminTarget.id,
        [{ id: ward.id, access: "write" }],
        staleSnapshot
      )
    );

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.toLowerCase()).toContain("reload");
    // The fresh opt-in survived — it was NOT silently revoked.
    expect(currentGrants(adminTarget.id)).toEqual([
      { profileId: ward.id, access: "write" },
      { profileId: other.id, access: "write" },
    ]);
  });

  it("leaves own_profile_id alone when an admin's row is removed (#1013)", async () => {
    // An admin's own-profile is inside their accessible set by ROLE, so revoking a
    // notification row can never strand it — nulling it here would silently drop them
    // out of the recipient union for the one profile that is theirs.
    db.prepare("UPDATE logins SET own_profile_id = ? WHERE id = ?").run(
      ward.id,
      adminTarget.id
    );
    db.prepare(
      "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')"
    ).run(adminTarget.id, ward.id);
    const snapshot = grantSignature([{ profileId: ward.id, access: "write" }]);

    const res = await setGrants(grantsForm(adminTarget.id, [], snapshot));

    expect(res.ok).toBe(true);
    expect(
      (
        db
          .prepare("SELECT own_profile_id AS o FROM logins WHERE id = ?")
          .get(adminTarget.id) as { o: number | null }
      ).o
    ).toBe(ward.id);
    // Which is why the union still reaches them for their own profile.
    expect(managingLoginIdsForProfile(ward.id)).toContain(adminTarget.id);
  });
});

describe("createLogin chooses a new login's profile rows (#1434 access, #2345 notifications)", () => {
  let p1: ReturnType<typeof createProfile>;
  let p2: ReturnType<typeof createProfile>;

  beforeEach(() => {
    const actor = createLogin({ role: "admin" });
    const actorProfile = createProfile("Creator Home");
    actAs(actor, actorProfile);
    p1 = createProfile("Create One");
    p2 = createProfile("Create Two");
  });

  function createForm(
    username: string,
    role: "admin" | "member",
    profileIds: number[]
  ): FormData {
    const f = new FormData();
    f.set("username", username);
    f.set("password", ACTION_TEST_PASSWORD);
    f.set("role", role);
    for (const id of profileIds) {
      f.append("profileId", String(id));
      f.set(`access_${id}`, "write");
    }
    return f;
  }

  function loginIdFor(username: string): number {
    return (
      db.prepare("SELECT id FROM logins WHERE username = ?").get(username) as {
        id: number;
      }
    ).id;
  }

  it("persists an ADMIN's submitted ids as its notification scope", async () => {
    const res = await createLoginAction(
      createForm("new-admin-2345", "admin", [p2.id])
    );
    expect(res.ok).toBe(true);

    const id = loginIdFor("new-admin-2345");
    expect(currentGrants(id)).toEqual([{ profileId: p2.id, access: "write" }]);
    // Which is the whole point: the new admin can actually be reached about p2…
    expect(managingLoginIdsForProfile(p2.id)).toContain(id);
    // …and is still NOT auto-subscribed to everything else.
    expect(managingLoginIdsForProfile(p1.id)).not.toContain(id);
    // Access is untouched by any of it — admins reach every profile by role.
    expect(accessibleProfilesForLogin(id).map((p) => p.id)).toEqual(
      expect.arrayContaining([p1.id, p2.id])
    );
  });

  it("still creates an admin with NO rows when none were chosen", async () => {
    const res = await createLoginAction(
      createForm("bare-admin-2345", "admin", [])
    );
    expect(res.ok).toBe(true);
    const id = loginIdFor("bare-admin-2345");
    expect(currentGrants(id)).toEqual([]);
    expect(managingLoginIdsForProfile(p1.id)).not.toContain(id);
  });

  it("leaves the MEMBER path exactly as it was — ids become access grants", async () => {
    const res = await createLoginAction(
      createForm("new-member-2345", "member", [p1.id])
    );
    expect(res.ok).toBe(true);

    const id = loginIdFor("new-member-2345");
    expect(currentGrants(id)).toEqual([{ profileId: p1.id, access: "write" }]);
    expect(accessibleProfilesForLogin(id).map((p) => p.id)).toEqual([p1.id]);
    expect(accessForProfile(id, "member", p2.id)).toBe("write"); // ungranted default
  });
});
