// SERVER-ACTION TIER — the wellness-practice one-tap log action (#1259).
//
// logPractice is the ONE shared write path (protocol detail, Active-protocols widget,
// and — via its own wrapper — the Telegram Done button). It runs through the auth-blind
// write core (logPracticeSession, profileId-first) behind requireWriteAccess. This pins:
//   - it writes against the ACTING profile (scoping),
//   - a second same-day tap appends a NEW session row (not idempotent — the PRN ledger
//     model) and reports the running count,
//   - the CAREGIVER shape: a member acting-as a child logs the CHILD's practice (the
//     write core is profileId-first, so this is a named case, not new code),
//   - deleteProfile's OWNED_TABLES sweep clears practice_logs.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { logPractice } from "@/app/(app)/protocols/actions";
import { deleteProfile } from "@/app/(app)/settings/family/actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

function rows(profileId: number): { practice: string; date: string }[] {
  return db
    .prepare(
      "SELECT practice, date FROM practice_logs WHERE profile_id = ? ORDER BY id"
    )
    .all(profileId) as { practice: string; date: string }[];
}

describe("logPractice action (#1259)", () => {
  it("logs a session for the acting profile and reports the running day count", async () => {
    const admin = createLogin({ role: "admin" });
    const profile = createProfile("Test Patient");
    actAs(admin, profile);

    const first = await logPractice(fd({ practice: "Red light therapy" }));
    expect(first).toEqual({
      kind: "logged",
      count: 1,
      date: today(profile.id),
    });

    // A deliberate second same-day tap → a NEW row, count 2 (multi-session days).
    const second = await logPractice(fd({ practice: "Red light therapy" }));
    expect(second).toMatchObject({ kind: "logged", count: 2 });

    expect(rows(profile.id)).toHaveLength(2);
    expect(rows(profile.id).every((r) => r.date === today(profile.id))).toBe(
      true
    );
  });

  it("refuses a blank practice name (nothing written)", async () => {
    const admin = createLogin({ role: "admin" });
    const profile = createProfile("Test Patient");
    actAs(admin, profile);

    const out = await logPractice(fd({ practice: "   " }));
    expect(out).toEqual({ kind: "invalid-date" });
    expect(rows(profile.id)).toHaveLength(0);
  });

  it("caregiver shape: a member acting-as a child logs the CHILD's practice", async () => {
    // A parent (member login) granted their child's profile, acting as the child from
    // the household surfaces — the PRN quick-log precedent. The write core is
    // profileId-first, so the acting profile IS the child.
    const parent = createLogin({ role: "member" });
    const child = createProfile("Kiddo", parent.id);
    const other = createProfile("Ada Lovelace"); // NOT granted / bystander
    actAs(parent, child, "write");

    const out = await logPractice(fd({ practice: "Wind-down routine" }));
    expect(out).toMatchObject({ kind: "logged", count: 1 });

    // The session landed on the CHILD, never the bystander.
    expect(rows(child.id)).toHaveLength(1);
    expect(rows(child.id)[0].practice).toBe("Wind-down routine");
    expect(rows(other.id)).toHaveLength(0);
  });

  it("deleteProfile clears practice_logs (OWNED_TABLES sweep)", async () => {
    const admin = createLogin({ role: "admin" });
    const acting = createProfile("Acting Admin");
    const victim = createProfile("Test Patient");
    const bystander = createProfile("Grace Hopper");
    actAs(admin, acting);

    // Seed the victim + a bystander directly (own-profile-agnostic write core).
    actAs(admin, victim);
    await logPractice(fd({ practice: "Sauna" }));
    actAs(admin, bystander);
    await logPractice(fd({ practice: "Sauna" }));
    actAs(admin, acting);

    expect(rows(victim.id)).toHaveLength(1);

    const res = await deleteProfile(fd({ id: victim.id }));
    expect(res.ok).toBe(true);

    expect(rows(victim.id)).toHaveLength(0);
    expect(rows(bystander.id)).toHaveLength(1); // bystander untouched
  });
});
