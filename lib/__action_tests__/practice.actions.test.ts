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
import {
  editPracticeSession,
  logPractice,
  removePracticeSession,
  savePractice,
} from "@/app/(app)/wellness/actions";
import { deleteProfile } from "@/app/(app)/settings/family/actions";
import { logUpcomingPractice } from "@/app/(app)/upcoming/actions";
import { createLogin, createProfile, actAs, fd } from "./harness";

function rows(profileId: number): { practice: string; date: string }[] {
  return db
    .prepare(
      "SELECT practice, date FROM practice_logs WHERE profile_id = ? ORDER BY id"
    )
    .all(profileId) as { practice: string; date: string }[];
}

function sessionId(profileId: number): number {
  const row = db
    .prepare(
      "SELECT id FROM practice_logs WHERE profile_id = ? ORDER BY id DESC LIMIT 1"
    )
    .get(profileId) as { id: number };
  return row.id;
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

  it("edits session details, reapplying the 30-day date guard", async () => {
    const admin = createLogin({ role: "admin" });
    const profile = createProfile("Editor");
    actAs(admin, profile);
    await logPractice(fd({ practice: "Meditation" }));
    const id = sessionId(profile.id);

    expect(
      await editPracticeSession(
        fd({ id, date: "2000-01-01", duration_min: 20 })
      )
    ).toEqual({ kind: "invalid-date" });

    const updated = await editPracticeSession(
      fd({
        id,
        date: today(profile.id),
        time: "07:30",
        duration_min: 20,
        notes: "Morning",
      })
    );
    expect(updated).toMatchObject({
      kind: "updated",
      session: {
        id,
        time: "07:30",
        duration_min: 20,
        notes: "Morning",
      },
    });
  });

  it("delete is profile-scoped and returns not-found for a foreign id", async () => {
    const admin = createLogin({ role: "admin" });
    const owner = createProfile("Owner");
    const other = createProfile("Other");
    actAs(admin, owner);
    await logPractice(fd({ practice: "Sauna" }));
    const id = sessionId(owner.id);

    actAs(admin, other);
    expect(await removePracticeSession(fd({ id }))).toEqual({
      kind: "not-found",
    });
    expect(rows(owner.id)).toHaveLength(1);

    actAs(admin, owner);
    expect(await removePracticeSession(fd({ id }))).toEqual({
      kind: "deleted",
      id,
    });
    expect(rows(owner.id)).toHaveLength(0);
  });

  it("renaming a practice rekeys its case-variant history", async () => {
    const admin = createLogin({ role: "admin" });
    const profile = createProfile("Rename");
    actAs(admin, profile);
    await logPractice(fd({ practice: " sauna " }));
    expect(
      await savePractice(fd({ name: "Sauna", per_week: 3, per_week_max: 5 }))
    ).toEqual({ ok: true });
    const target = db
      .prepare(
        `SELECT id FROM frequency_targets
          WHERE profile_id = ? AND scope_kind = 'practice'`
      )
      .get(profile.id) as { id: number };

    expect(
      await savePractice(
        fd({
          target_id: target.id,
          name: "Heat therapy",
          per_week: 2,
          per_week_max: 4,
        })
      )
    ).toEqual({ ok: true });
    expect(rows(profile.id).map((row) => row.practice)).toEqual([
      "Heat therapy",
    ]);
  });

  it("Upcoming logs by stable target id and returns the core outcome", async () => {
    const admin = createLogin({ role: "admin" });
    const profile = createProfile("Upcoming");
    actAs(admin, profile);
    await savePractice(fd({ name: "Breathwork", per_week: 3 }));
    const target = db
      .prepare(
        `SELECT id FROM frequency_targets
          WHERE profile_id = ? AND scope_kind = 'practice'`
      )
      .get(profile.id) as { id: number };

    const result = await logUpcomingPractice(
      fd({ profile_id: profile.id, target_id: target.id })
    );
    expect(result).toEqual({
      ok: true,
      outcome: { kind: "logged", count: 1, date: today(profile.id) },
    });
    expect(rows(profile.id)).toHaveLength(1);
  });
});
