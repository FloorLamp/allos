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
  deletePractice,
  editPracticeSession,
  logPractice,
  removePracticeSession,
  savePractice,
  untrackPractice,
} from "@/app/(app)/wellness/actions";
import { undoDelete } from "@/app/(app)/undo-actions";
import { deleteProfile } from "@/app/(app)/settings/family/actions";
import { logUpcomingPractice } from "@/app/(app)/upcoming/actions";
import { getWellnessPractices } from "@/lib/queries/wellness";
import { practiceSignalKey } from "@/lib/practice";
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

    // Since #2038 the action answers in the `{ undoId }` shape the shared Undo toast
    // consumes: a refused delete carries the message and no token, a real one carries
    // the token that puts the session back.
    actAs(admin, other);
    expect(await removePracticeSession(fd({ id }))).toEqual({
      undoId: null,
      error: "Couldn't find that session.",
    });
    expect(rows(owner.id)).toHaveLength(1);

    actAs(admin, owner);
    expect(await removePracticeSession(fd({ id }))).toEqual({
      undoId: expect.any(Number),
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

  it("rejects a weekly maximum at or below the minimum without writing (#1619)", async () => {
    const admin = createLogin({ role: "admin" });
    const profile = createProfile("Invalid cadence");
    actAs(admin, profile);

    expect(
      await savePractice(fd({ name: "Sauna", per_week: 5, per_week_max: 3 }))
    ).toEqual({
      ok: false,
      error: "The weekly maximum must be greater than the minimum.",
    });
    expect(
      db
        .prepare(
          `SELECT id FROM frequency_targets
            WHERE profile_id = ? AND scope_kind = 'practice'`
        )
        .all(profile.id)
    ).toEqual([]);
  });

  it("stops weekly tracking without deleting sessions and unlinks protocols", async () => {
    const admin = createLogin({ role: "admin" });
    const profile = createProfile("Untrack");
    actAs(admin, profile);
    await logPractice(fd({ practice: "Sauna" }));
    await savePractice(fd({ name: "Sauna", per_week: 3 }));
    const target = db
      .prepare(
        `SELECT id FROM frequency_targets
          WHERE profile_id = ? AND scope_kind = 'practice'`
      )
      .get(profile.id) as { id: number };
    const protocolId = Number(
      db
        .prepare(
          `INSERT INTO protocols
             (profile_id, name, start_date, frequency_target_id)
           VALUES (?, 'Sauna block', ?, ?)`
        )
        .run(profile.id, today(profile.id), target.id).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO upcoming_dismissals
         (profile_id, signal_key, dismissed_at)
       VALUES (?, ?, datetime('now'))`
    ).run(profile.id, practiceSignalKey(target.id));

    expect(await untrackPractice(fd({ target_id: target.id }))).toEqual({
      ok: true,
    });
    expect(
      db
        .prepare(
          "SELECT 1 FROM frequency_targets WHERE id = ? AND profile_id = ?"
        )
        .get(target.id, profile.id)
    ).toBeUndefined();
    expect(
      db
        .prepare(
          "SELECT frequency_target_id FROM protocols WHERE id = ? AND profile_id = ?"
        )
        .get(protocolId, profile.id)
    ).toEqual({ frequency_target_id: null });
    expect(rows(profile.id)).toHaveLength(1);
    expect(
      db
        .prepare(
          `SELECT 1 FROM upcoming_dismissals
            WHERE profile_id = ? AND signal_key = ?`
        )
        .get(profile.id, practiceSignalKey(target.id))
    ).toBeUndefined();
  });

  it("deletes a tracked practice family and undo restores its target, sessions, dismissal, and card (#1621)", async () => {
    const admin = createLogin({ role: "admin" });
    const profile = createProfile("Practice undo");
    actAs(admin, profile);
    await savePractice(fd({ name: "Breathwork", per_week: 3 }));
    await logPractice(fd({ practice: "Breathwork" }));
    await logPractice(fd({ practice: " breathwork " }));
    const target = db
      .prepare(
        `SELECT id FROM frequency_targets
          WHERE profile_id = ? AND scope_kind = 'practice'`
      )
      .get(profile.id) as { id: number };
    const protocolId = Number(
      db
        .prepare(
          `INSERT INTO protocols
             (profile_id, name, start_date, frequency_target_id)
           VALUES (?, 'Breathwork block', ?, ?)`
        )
        .run(profile.id, today(profile.id), target.id).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO upcoming_dismissals
         (profile_id, signal_key, snooze_until)
       VALUES (?, ?, ?)`
    ).run(profile.id, practiceSignalKey(target.id), today(profile.id));

    const deleted = await deletePractice(
      fd({ target_id: target.id, practice: "Breathwork" })
    );
    expect(deleted.error).toBeUndefined();
    expect(deleted.undoId).toEqual(expect.any(Number));
    expect(rows(profile.id)).toHaveLength(0);
    expect(
      db
        .prepare(
          "SELECT 1 FROM frequency_targets WHERE id = ? AND profile_id = ?"
        )
        .get(target.id, profile.id)
    ).toBeUndefined();
    expect(
      db
        .prepare(
          `SELECT frequency_target_id FROM protocols
            WHERE id = ? AND profile_id = ?`
        )
        .get(protocolId, profile.id)
    ).toEqual({ frequency_target_id: null });
    expect(
      db
        .prepare(
          `SELECT 1 FROM upcoming_dismissals
            WHERE profile_id = ? AND signal_key = ?`
        )
        .get(profile.id, practiceSignalKey(target.id))
    ).toBeUndefined();

    expect(await undoDelete(deleted.undoId!)).toEqual({ ok: true });
    const restoredTarget = db
      .prepare(
        `SELECT id FROM frequency_targets
          WHERE profile_id = ? AND scope_kind = 'practice'
            AND scope_value = 'Breathwork'`
      )
      .get(profile.id) as { id: number };
    expect(restoredTarget.id).not.toBe(target.id);
    expect(rows(profile.id)).toHaveLength(2);
    expect(
      db
        .prepare(
          `SELECT snooze_until FROM upcoming_dismissals
            WHERE profile_id = ? AND signal_key = ?`
        )
        .get(profile.id, practiceSignalKey(restoredTarget.id))
    ).toEqual({ snooze_until: today(profile.id) });
    expect(getWellnessPractices(profile.id)).toMatchObject([
      {
        name: "Breathwork",
        targetId: restoredTarget.id,
        sessionCount: 2,
      },
    ]);
  });

  it("practice-family delete is profile-scoped for tracked and logs-only cards (#1621)", async () => {
    const admin = createLogin({ role: "admin" });
    const owner = createProfile("Practice owner");
    const other = createProfile("Practice bystander");
    actAs(admin, owner);
    await savePractice(fd({ name: "Sauna", per_week: 2 }));
    await logPractice(fd({ practice: "Sauna" }));
    const target = db
      .prepare(
        `SELECT id FROM frequency_targets
          WHERE profile_id = ? AND scope_kind = 'practice'`
      )
      .get(owner.id) as { id: number };

    actAs(admin, other);
    expect(
      await deletePractice(fd({ target_id: target.id, practice: "Sauna" }))
    ).toEqual({
      undoId: null,
      error: "Couldn't find that practice.",
    });
    expect(await deletePractice(fd({ practice: "Sauna" }))).toEqual({
      undoId: null,
      error: "Couldn't find that practice.",
    });
    expect(rows(owner.id)).toHaveLength(1);
    expect(
      db
        .prepare(
          "SELECT 1 FROM frequency_targets WHERE id = ? AND profile_id = ?"
        )
        .get(target.id, owner.id)
    ).toBeTruthy();
  });

  it("deletes and restores a logs-only practice without inventing a target (#1621)", async () => {
    const admin = createLogin({ role: "admin" });
    const profile = createProfile("Logs-only undo");
    actAs(admin, profile);
    await logPractice(fd({ practice: "Meditation" }));
    await logPractice(fd({ practice: "MEDITATION" }));

    const deleted = await deletePractice(fd({ practice: "meditation" }));
    expect(deleted.error).toBeUndefined();
    expect(deleted.undoId).toEqual(expect.any(Number));
    expect(rows(profile.id)).toHaveLength(0);
    expect(getWellnessPractices(profile.id)).toEqual([]);

    expect(await undoDelete(deleted.undoId!)).toEqual({ ok: true });
    expect(rows(profile.id)).toHaveLength(2);
    expect(getWellnessPractices(profile.id)).toMatchObject([
      {
        targetId: null,
        perWeek: null,
        sessionCount: 2,
      },
    ]);
    expect(
      db
        .prepare(
          `SELECT 1 FROM frequency_targets
            WHERE profile_id = ? AND scope_kind = 'practice'`
        )
        .get(profile.id)
    ).toBeUndefined();
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
