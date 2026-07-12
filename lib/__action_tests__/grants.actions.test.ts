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
import { setGrants } from "@/app/(app)/settings/family/actions";
import { grantSignature, type Access } from "@/lib/grants";
import { createLogin, createProfile, actAs } from "./harness";

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
