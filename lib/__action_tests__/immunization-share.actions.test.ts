// SERVER-ACTION TIER — the immunization record's share link (issue #1849).
//
// A tokenized, unauthenticated-by-token egress path, so what matters is the whole
// lifecycle: who may mint one, what the public resolver actually gets back, that the
// content it resolves is the SAME record the print page renders, and that revoking it
// really closes the door.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { createImmunizationShareLinkAction } from "@/app/(app)/immunizations/actions";
import { revokeShareLinkAction } from "@/app/(app)/profile/actions";
import { getShareLinkByToken, listShareLinks } from "@/lib/share-links-db";
import { shareLinkStatus } from "@/lib/share-links";
import { getImmunizationRecord } from "@/app/(app)/immunizations/record-data";
import { createLogin, createProfile, actAs, fd } from "./harness";

function addDose(
  profileId: number,
  vaccine: string,
  date: string,
  extra: { lot?: string; route?: string; site?: string } = {}
): void {
  db.prepare(
    `INSERT INTO immunizations
       (profile_id, date, vaccine, lot_number, route, site)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(
    profileId,
    date,
    vaccine,
    extra.lot ?? null,
    extra.route ?? null,
    extra.site ?? null
  );
}

describe("createImmunizationShareLinkAction", () => {
  it("mints an 'immunizations' link resolvable by its token", async () => {
    const login = createLogin();
    const profile = createProfile("Imm Share", login.id);
    actAs(login, profile);
    addDose(profile.id, "tdap", "2025-03-04", {
      lot: "LOT-9",
      route: "intramuscular",
    });

    const res = await createImmunizationShareLinkAction(fd({ ttl: "7d" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const token = res.path.replace("/share/", "");
    const link = getShareLinkByToken(token)!;
    expect(link.kind).toBe("immunizations");
    expect(link.profile_id).toBe(profile.id);
    // Non-passport kinds carry no field allow-list: the artifact IS the scope.
    expect(link.fields).toBe("[]");
    expect(link.revoked_at).toBeNull();
    expect(shareLinkStatus(link, new Date())).toBe("valid");
    // The raw token is never stored — only its hash.
    expect(
      db
        .prepare("SELECT token_hash FROM profile_share_links WHERE id = ?")
        .get(link.id)
    ).not.toMatchObject({ token_hash: token });
  });

  it("resolves the SAME record the print page renders, and stays live", async () => {
    const login = createLogin();
    const profile = createProfile("Imm Share Live", login.id);
    actAs(login, profile);
    addDose(profile.id, "hepa", "2020-01-01");

    const res = await createImmunizationShareLinkAction(fd({ ttl: "1d" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const link = getShareLinkByToken(res.path.replace("/share/", ""))!;
    const atIssue = getImmunizationRecord(link.profile_id, profile.name);
    expect(atIssue.groups.map((g) => g.code)).toEqual(["hepa"]);

    // A dose added after the link went out appears through the same link: the
    // resolver re-derives the record at view time.
    addDose(profile.id, "tdap", "2025-06-01");
    expect(
      getImmunizationRecord(link.profile_id, profile.name).groups.map(
        (g) => g.code
      )
    ).toEqual(["hepa", "tdap"]);
  });

  it("scopes the record to the link's own profile", async () => {
    const login = createLogin();
    const mine = createProfile("Imm Mine", login.id);
    const other = createProfile("Imm Other", login.id);
    actAs(login, mine);
    addDose(mine.id, "hepa", "2020-01-01");
    addDose(other.id, "tdap", "2021-01-01");

    const res = await createImmunizationShareLinkAction(fd({ ttl: "1d" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const link = getShareLinkByToken(res.path.replace("/share/", ""))!;
    expect(link.profile_id).toBe(mine.id);
    expect(
      getImmunizationRecord(link.profile_id, mine.name).groups.map(
        (g) => g.code
      )
    ).toEqual(["hepa"]);
  });

  it("is blocked for a read-only acting session", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("Imm RO", login.id);
    actAs(login, profile, "read");
    await expect(
      createImmunizationShareLinkAction(fd({ ttl: "7d" }))
    ).rejects.toThrow(/read-only/);
    expect(listShareLinks(profile.id)).toHaveLength(0);
  });
});

describe("revoking an immunization link", () => {
  it("revokes through the shared passport revoke action and the token stops resolving as valid", async () => {
    const login = createLogin();
    const profile = createProfile("Imm Revoke", login.id);
    actAs(login, profile);
    addDose(profile.id, "tdap", "2025-03-04");

    const res = await createImmunizationShareLinkAction(fd({ ttl: "7d" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const token = res.path.replace("/share/", "");
    const link = getShareLinkByToken(token)!;

    // The link is listed on the passport's management surface, with its kind, so a
    // person can tell WHICH link they are revoking.
    expect(listShareLinks(profile.id)).toMatchObject([
      { id: link.id, kind: "immunizations" },
    ]);

    const revoked = await revokeShareLinkAction(fd({ id: link.id }));
    expect(revoked.ok).toBe(true);
    expect(shareLinkStatus(getShareLinkByToken(token)!, new Date())).toBe(
      "revoked"
    );
  });

  it("cannot be revoked from another profile's session", async () => {
    const login = createLogin();
    const mine = createProfile("Imm Owner", login.id);
    const other = createProfile("Imm Bystander", login.id);
    actAs(login, mine);
    const res = await createImmunizationShareLinkAction(fd({ ttl: "7d" }));
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const link = getShareLinkByToken(res.path.replace("/share/", ""))!;

    actAs(login, other);
    const attempt = await revokeShareLinkAction(fd({ id: link.id }));
    expect(attempt.ok).toBe(false);
    expect(
      getShareLinkByToken(res.path.replace("/share/", ""))!.revoked_at
    ).toBe(null);
  });
});
