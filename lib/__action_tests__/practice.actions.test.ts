// SERVER-ACTION TIER — the wellness-practice one-tap log action (#1259).
//
// logPractice is the ONE shared write path (protocol detail, Wellness card,
// and — via its own wrapper — the Telegram Done button). It runs through the auth-blind
// write core (logPracticeSession, profileId-first) behind requireWriteAccess. This pins:
//   - it writes against the ACTING profile (scoping),
//   - a second same-day tap appends a NEW session row (not idempotent — the PRN ledger
//     model) and reports the running count,
//   - the CAREGIVER shape: a member acting-as a child logs the CHILD's practice (the
//     write core is profileId-first, so this is a named case, not new code),
//   - deleteProfile's OWNED_TABLES sweep clears practice_logs.

import { describe, it, expect, beforeEach } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  deletePractice,
  editPracticeSession,
  endPracticeLive,
  logPractice,
  removePracticeSession,
  savePractice,
  startPracticeLive,
  untrackPractice,
} from "@/app/(app)/wellness/actions";
import { undoDelete } from "@/app/(app)/undo-actions";
import { deleteProfile } from "@/app/(app)/settings/family/actions";
import { getWellnessPractices } from "@/lib/queries/wellness";
import { practiceSignalKey } from "@/lib/practice";
import { createLogin, createProfile, actAs, fd } from "./harness";
import { now as clockNow } from "@/lib/clock";
import { zonedDateParts } from "@/lib/date";
import { getTimezone } from "@/lib/settings";

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
  it("rejects a blank name, then logs additive sessions for the acting profile", async () => {
    const admin = createLogin({ role: "admin" });
    const profile = createProfile("Test Patient");
    actAs(admin, profile);

    const invalid = await logPractice(fd({ practice: "   " }));
    expect(invalid).toEqual({ kind: "invalid-date" });
    expect(rows(profile.id)).toHaveLength(0);

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

  it("edits an owned session and refuses a foreign delete before deleting it", async () => {
    const admin = createLogin({ role: "admin" });
    const profile = createProfile("Editor");
    const other = createProfile("Other");
    actAs(admin, profile);
    await logPractice(fd({ practice: "Meditation" }));
    const id = sessionId(profile.id);

    // #4425 owner ruling: a DATED correction surface reaches any real past day, so an
    // old imported session is correctable in place. What it may never be is future.
    expect(
      await editPracticeSession(
        fd({ id, date: "2000-01-01", duration_min: 20 })
      )
    ).toMatchObject({ kind: "updated" });
    expect(
      await editPracticeSession(
        fd({
          id,
          date: shiftDateStr(today(profile.id), 1),
          duration_min: 20,
        })
      )
    ).toEqual({ kind: "invalid-date" });

    const updated = await editPracticeSession(
      fd({
        id,
        date: today(profile.id),
        start_time: "07:30",
        end_time: "07:50",
        duration_min: 20,
        notes: "Morning",
      })
    );
    expect(updated).toMatchObject({
      kind: "updated",
      session: {
        id,
        start_time: "07:30",
        // The END the form stated, written and read back (#3142).
        end_time: "07:50",
        duration_min: 20,
        notes: "Morning",
      },
    });

    // Since #2038 the action answers in the `{ undoId }` shape the shared Undo toast
    // consumes: a refused delete carries the message and no token, a real one carries
    // the token that puts the session back.
    actAs(admin, other);
    expect(await removePracticeSession(fd({ id }))).toEqual({
      undoId: null,
      error: "Couldn't find that session.",
    });
    expect(rows(profile.id)).toHaveLength(1);

    actAs(admin, profile);
    expect(await removePracticeSession(fd({ id }))).toEqual({
      undoId: expect.any(Number),
    });
    expect(rows(profile.id)).toHaveLength(0);
  });

  it("validates, renames, and untracks a target without deleting sessions", async () => {
    const admin = createLogin({ role: "admin" });
    const profile = createProfile("Rename");
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

    const protocolId = Number(
      db
        .prepare(
          `INSERT INTO protocols
             (profile_id, name, start_date, frequency_target_id)
           VALUES (?, 'Heat block', ?, ?)`
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

  it("scopes tracked-family deletion, then restores its full graph on undo (#1621)", async () => {
    const admin = createLogin({ role: "admin" });
    const profile = createProfile("Practice undo");
    const other = createProfile("Practice bystander");
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

    actAs(admin, other);
    expect(
      await deletePractice(fd({ target_id: target.id, practice: "Breathwork" }))
    ).toEqual({
      undoId: null,
      error: "Couldn't find that practice.",
    });
    expect(await deletePractice(fd({ practice: "Breathwork" }))).toEqual({
      undoId: null,
      error: "Couldn't find that practice.",
    });
    expect(rows(profile.id)).toHaveLength(2);
    expect(
      db
        .prepare(
          "SELECT 1 FROM frequency_targets WHERE id = ? AND profile_id = ?"
        )
        .get(target.id, profile.id)
    ).toBeTruthy();

    actAs(admin, profile);

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
});

// ── THE SUBJECT, RE-GATED SERVER-SIDE (#4424 ruling 4 + ruling 7) ───────────────
//
// Upcoming's multi-view rows mount the shared `LogPracticeButton`, so the three
// actions it posts stopped resolving their subject from the SESSION and take the row's
// `profile_id` through `gateItemProfile`. `logUpcomingPractice` — which spelled that
// same two-branch gate inline behind its own button — is deleted with it.
//
// THE ACCEPTANCE IS THE REFUSAL, NOT THE ABSENCE (#4009's wording, and this leg is the
// add-path twin of the record's correction table): a missing button is a claim about
// the renderer, satisfied equally by a page that draws nothing and by an action that
// would happily have written. So every case here builds the FormData a forged submit
// would carry and calls the real action.
//
// AND THE THIRD ARM IS WHY THE FIRST TWO ARE NOT ENOUGH: a gate that refused every
// cross-profile post would pass both refusals while having taken the capability away.
describe("practice writes gate the ROW's profile (#4424 ruling 7)", () => {
  const practiceRows = (profileId: number) =>
    db
      .prepare(
        "SELECT id, live FROM practice_logs WHERE profile_id = ? ORDER BY id"
      )
      .all(profileId) as { id: number; live: number }[];

  const VERBS = [
    {
      name: "logPractice",
      post: () => ({ practice: "Breathwork" }),
      fn: logPractice,
    },
    {
      name: "startPracticeLive",
      post: () => ({ practice: "Breathwork" }),
      fn: startPracticeLive,
    },
  ] as const;

  it.each(VERBS)(
    "$name refuses an ungranted and a read-only subject, writing nothing",
    async ({ post, fn }) => {
      const login = createLogin({ role: "member" });
      const acting = createProfile("acting practice subject", login.id);
      const ungranted = createProfile("ungranted practice subject");
      const readOnly = createProfile("readonly practice subject");
      db.prepare(
        "INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'read')"
      ).run(login.id, readOnly.id);
      actAs(login, acting);

      for (const target of [ungranted, readOnly]) {
        // requireProfileWriteAccess answers with redirect(), which throws
        // NEXT_REDIRECT, so the action aborts before any core runs.
        await expect(
          fn(fd({ ...post(), profile_id: target.id }))
        ).rejects.toThrow();
        expect(practiceRows(target.id)).toHaveLength(0);
        // AND NOT ON THE CAREGIVER EITHER: `logPracticeSession` is keyed on
        // (profile, practice, day) rather than on a row id, so an action that ignored
        // the posted subject would not fail to find anything — it would write the
        // ACTING profile's own session and answer `logged`.
        expect(practiceRows(acting.id)).toHaveLength(0);
      }
    }
  );

  it("lands a session, and its live lifecycle, on a WRITE-granted member's row", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("acting practice grant", login.id);
    const member = createProfile("member practice grant", login.id);
    actAs(login, acting);

    expect(
      await logPractice(fd({ practice: "Breathwork", profile_id: member.id }))
    ).toEqual({ kind: "logged", count: 1, date: today(member.id) });
    expect(practiceRows(member.id)).toHaveLength(1);
    expect(practiceRows(acting.id)).toHaveLength(0);

    const started = await startPracticeLive(
      fd({ practice: "Sauna", profile_id: member.id })
    );
    expect(started.kind).toBe("started");
    expect(practiceRows(member.id).filter((r) => r.live === 1)).toHaveLength(1);

    // The END takes the same subject: `endLivePracticeSession` is (profile, id)
    // scoped, so a session id gated to the acting profile would no-op rather than
    // close the member's running row.
    const liveId = practiceRows(member.id).find((r) => r.live === 1)!.id;
    const ended = await endPracticeLive(
      fd({ id: liveId, profile_id: member.id })
    );
    expect(ended.kind).toBe("ended");
    expect(practiceRows(member.id).filter((r) => r.live === 1)).toHaveLength(0);
  });
});

// ── #3273: the quick-log sheet states an earlier session ────────────────────────
//
// The sheet mounts LogPracticeButton without `showDetails`, so the only surface that
// carried a time was a modal it deliberately does not open — a late-logged session
// wore the tap instant and #4009's correction had to repair it afterwards. The button
// now posts `time` from a collapsed WhenControl, and the whole contract is the THREE
// states of that one field, because `logPractice` reads them differently: absent means
// "stamp the tap instant", present-and-empty means "nobody said", present means the
// statement. Only the first is the untouched one-tap path.
describe("logPractice — the stated session time (#3273)", () => {
  const NOW_ISO = "2026-07-08T21:30:00Z";
  let priorNow: string | undefined;
  beforeEach(() => {
    priorNow = process.env.ALLOS_TEST_NOW;
    process.env.ALLOS_TEST_NOW = NOW_ISO;
    return () => {
      if (priorNow == null) delete process.env.ALLOS_TEST_NOW;
      else process.env.ALLOS_TEST_NOW = priorNow;
    };
  });

  function logged(profileId: number) {
    return db
      .prepare(
        `SELECT date, start_time, duration_min, notes, logged_via FROM practice_logs
          WHERE profile_id = ? ORDER BY id`
      )
      .all(profileId) as {
      date: string;
      start_time: string | null;
      duration_min: number | null;
      notes: string | null;
      logged_via: string;
    }[];
  }

  it.each([
    // field on the post          expected `start_time`   what the sheet is doing
    [
      undefined,
      "tap",
      "an untouched one-tap — the affordance was never opened",
    ],
    ["07:05", "07:05", 'a stated "Happened earlier?" minute'],
    ["", null, "the field present and empty — nobody said, honestly stored"],
  ])("start_time=%s writes %s", async (field, expected, _why) => {
    const login = createLogin();
    const profile = createProfile(`when-${expected}`, login.id);
    actAs(login, profile);
    const tapHhmm = zonedDateParts(getTimezone(profile.id), clockNow()).hhmm;

    await logPractice(fd({ practice: "Sauna", start_time: field }));

    const [row] = logged(profile.id);
    expect(row.start_time).toBe(expected === "tap" ? tapHhmm : expected);
    // Nothing ELSE moved. The one-tap row is the row it always was — the duration and
    // notes a details submit would carry stay absent, and the day is still today's.
    expect(row).toMatchObject({
      date: today(profile.id),
      duration_min: null,
      notes: null,
    });
  });
});
