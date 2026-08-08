// SERVER-ACTION TIER — illness-episode actions (issues #801/#856).
//
// Drives the real promote-to-condition / undo / episode-share / end actions through the
// (mocked) auth guard against a real temp DB. Post-#856 the actions resolve the episode
// by its STABLE ROW id (scoped to the profile), then bridge to a Condition, mint a share
// link, or end it. Asserts the auth gate (requireWriteAccess) and the rows written.

import { describe, it, expect, beforeEach } from "vitest";
import { db } from "@/lib/db";
import {
  promoteEpisodeToConditionAction,
  unpromoteEpisodeConditionAction,
  createEpisodeShareLinkAction,
  endEpisodeAction,
  reopenEpisodeAction,
  editEpisodeAction,
  createEpisodeAction,
  mergeEpisodesAction,
  updateEpisodeTemperatureAction,
  updateEpisodeSymptomAction,
  updateEpisodeDoseAction,
  deleteEpisodeTemperatureAction,
  deleteEpisodeDoseAction,
} from "@/app/(app)/medical/episodes/actions";
import { getShareLinkByToken } from "@/lib/share-links-db";
import { logSymptomCore } from "@/lib/symptom-log-write";
import { resolveSituationId } from "@/lib/settings";
import {
  getEpisodeRow,
  getOpenEpisodeRow,
  listEpisodeRows,
} from "@/lib/illness-episode-store";
import { today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { logTemperatureCore } from "@/lib/temperature-log";
import { createLogin, createProfile, actAs, fd } from "./harness";

// Make the acting profile currently sick with an ongoing Illness episode ROW; return id.
function makeSick(profileId: number): number {
  resolveSituationId(profileId, "Illness"); // born illness_type=1
  db.prepare(
    `UPDATE situations SET active = 1 WHERE profile_id = ? AND name = 'Illness'`
  ).run(profileId);
  const start = shiftDateStr(today(profileId), -2);
  db.prepare(
    `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
     VALUES (?, 'Illness', ?, NULL)`
  ).run(profileId, start);
  logSymptomCore(profileId, "cough", 2, today(profileId));
  return getOpenEpisodeRow(profileId, "Illness")!.id;
}

// Insert a CLOSED episode row directly; return its id. `end` is the inclusive last
// active day (#2232).
function createEpisodeRowFor(
  profileId: number,
  start: string,
  end: string
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
         VALUES (?, 'Illness', ?, ?)`
      )
      .run(profileId, start, end).lastInsertRowid
  );
}

describe("promoteEpisodeToConditionAction", () => {
  let profileId: number;
  let episodeId: number;
  beforeEach(() => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Promote Actor", login.id);
    actAs(login, profile);
    profileId = profile.id;
    episodeId = makeSick(profileId);
  });

  it("creates an active episode-sourced condition, then undo removes it", async () => {
    const res = await promoteEpisodeToConditionAction(fd({ episodeId }));
    expect(res.ok).toBe(true);
    const row = db
      .prepare(
        `SELECT name, status, resolved_date, source, external_id
           FROM conditions WHERE profile_id = ?`
      )
      .get(profileId) as {
      name: string;
      status: string;
      resolved_date: string | null;
      source: string;
      external_id: string;
    };
    expect(row.name).toBe("Illness");
    expect(row.status).toBe("active"); // ongoing episode
    expect(row.resolved_date).toBeNull();
    expect(row.source).toBe("episode");

    // Idempotent re-promote, still one row.
    await promoteEpisodeToConditionAction(fd({ episodeId }));
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM conditions WHERE profile_id = ?")
          .get(profileId) as { n: number }
      ).n
    ).toBe(1);

    // Undo deletes it.
    const undo = await unpromoteEpisodeConditionAction(fd({ episodeId }));
    expect(undo.ok).toBe(true);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM conditions WHERE profile_id = ?")
          .get(profileId) as { n: number }
      ).n
    ).toBe(0);
  });

  it("rejects a garbage episode id without writing", async () => {
    const res = await promoteEpisodeToConditionAction(
      fd({ episodeId: "nope" })
    );
    expect(res.ok).toBe(false);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM conditions WHERE profile_id = ?")
          .get(profileId) as { n: number }
      ).n
    ).toBe(0);
  });

  it("errors when no episode row matches the id", async () => {
    const res = await promoteEpisodeToConditionAction(
      fd({ episodeId: episodeId + 9999 })
    );
    expect(res.ok).toBe(false);
  });
});

describe("endEpisodeAction", () => {
  it("closes the episode and resolves its promoted condition", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("End Actor", login.id);
    actAs(login, profile);
    const episodeId = makeSick(profile.id);
    await promoteEpisodeToConditionAction(fd({ episodeId }));

    const res = await endEpisodeAction(fd({ episodeId }));
    expect(res.ok).toBe(true);

    const row = db
      .prepare(`SELECT end_date FROM illness_episodes WHERE id = ?`)
      .get(episodeId) as { end_date: string | null };
    expect(row.end_date).toBe(today(profile.id));
    // The situation is deactivated (no open row remains).
    expect(getOpenEpisodeRow(profile.id, "Illness")).toBeNull();
    const condition = db
      .prepare(
        `SELECT status, onset_date, resolved_date, external_id
           FROM conditions WHERE profile_id = ? AND source = 'episode'`
      )
      .get(profile.id) as {
      status: string;
      onset_date: string | null;
      resolved_date: string | null;
      external_id: string;
    };
    expect(condition.status).toBe("resolved");
    // Today remains the last active day, so today's logs stay in the episode and the
    // promoted Condition resolves today.
    expect(condition.resolved_date).toBe(today(profile.id));
    expect(condition.external_id).toBe(`illness-episode:${episodeId}`);
  });

  it("reopens a recent episode and reactivates its promoted condition", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Reopen Actor", login.id);
    actAs(login, profile);
    const episodeId = makeSick(profile.id);
    await promoteEpisodeToConditionAction(fd({ episodeId }));
    await endEpisodeAction(fd({ episodeId }));

    const res = await reopenEpisodeAction(fd({ episodeId }));
    expect(res.ok).toBe(true);
    expect(getOpenEpisodeRow(profile.id, "Illness")?.id).toBe(episodeId);
    expect(getEpisodeRow(profile.id, episodeId)?.end_date).toBeNull();
    const condition = db
      .prepare(
        `SELECT status, resolved_date FROM conditions
          WHERE profile_id = ? AND source = 'episode'`
      )
      .get(profile.id) as { status: string; resolved_date: string | null };
    expect(condition).toEqual({ status: "active", resolved_date: null });
  });

  it("refuses to reopen an episode after the relapse window", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Old Episode Actor", login.id);
    actAs(login, profile);
    resolveSituationId(profile.id, "Illness");
    const episodeId = createEpisodeRowFor(
      profile.id,
      shiftDateStr(today(profile.id), -14),
      shiftDateStr(today(profile.id), -8)
    );

    const res = await reopenEpisodeAction(fd({ episodeId }));
    expect(res).toEqual({
      ok: false,
      error:
        "This illness ended too long ago to reopen. Start a new episode instead.",
    });
    expect(getEpisodeRow(profile.id, episodeId)?.end_date).toBe(
      shiftDateStr(today(profile.id), -8)
    );
    expect(getOpenEpisodeRow(profile.id, "Illness")).toBeNull();
  });
});

describe("editEpisodeAction (boundaries + annotations, item 1)", () => {
  it("edits a closed episode's dates, note, and outcome as a plain row edit", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Edit Actor", login.id);
    actAs(login, profile);
    const newId = createEpisodeRowFor(profile.id, "2026-05-01", "2026-05-06");
    await promoteEpisodeToConditionAction(fd({ episodeId: newId }));

    const res = await editEpisodeAction(
      fd({
        episodeId: newId,
        startDate: "2026-04-30",
        endDate: "2026-05-05",
        note: "pediatrician said rest",
        outcome: "self-resolved",
      })
    );
    expect(res.ok).toBe(true);
    const row = getEpisodeRow(profile.id, newId)!;
    expect(row.start_date).toBe("2026-04-30");
    expect(row.end_date).toBe("2026-05-05");
    expect(row.note).toBe("pediatrician said rest");
    expect(row.outcome).toBe("self-resolved");
    const condition = db
      .prepare(
        `SELECT onset_date, resolved_date, external_id
           FROM conditions WHERE profile_id = ? AND source = 'episode'`
      )
      .get(profile.id) as {
      onset_date: string | null;
      resolved_date: string | null;
      external_id: string;
    };
    expect(condition.onset_date).toBe("2026-04-30");
    // The inclusive end IS the last active day, so the condition resolves ON it.
    expect(condition.resolved_date).toBe("2026-05-05");
    expect(condition.external_id).toBe(`illness-episode:${newId}`);

    // Correcting the start did not detach the promotion or allow a duplicate.
    await promoteEpisodeToConditionAction(fd({ episodeId: newId }));
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM conditions WHERE profile_id = ?")
          .get(profile.id) as { n: number }
      ).n
    ).toBe(1);
    await unpromoteEpisodeConditionAction(fd({ episodeId: newId }));
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM conditions WHERE profile_id = ?")
          .get(profile.id) as { n: number }
      ).n
    ).toBe(0);
  });

  it("rejects an end before the start, allows a one-day episode (end == start)", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Bad Range", login.id);
    actAs(login, profile);
    const newId = createEpisodeRowFor(profile.id, "2026-05-01", "2026-05-06");
    const res = await editEpisodeAction(
      fd({ episodeId: newId, startDate: "2026-05-05", endDate: "2026-05-04" })
    );
    expect(res.ok).toBe(false);
    const oneDay = await editEpisodeAction(
      fd({ episodeId: newId, startDate: "2026-05-05", endDate: "2026-05-05" })
    );
    expect(oneDay.ok).toBe(true);
    expect(getEpisodeRow(profile.id, newId)!.end_date).toBe("2026-05-05");
  });

  it("keeps an OPEN episode's end null (the toggle owns closing it)", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Open Edit", login.id);
    actAs(login, profile);
    const episodeId = makeSick(profile.id);
    await editEpisodeAction(
      fd({ episodeId, startDate: "2026-05-01", endDate: "2026-05-04" })
    );
    expect(getEpisodeRow(profile.id, episodeId)!.end_date).toBeNull();
  });
});

describe("createEpisodeAction + mergeEpisodesAction (retro + flap-merge, item 1)", () => {
  it("retro-creates a closed episode", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Retro", login.id);
    actAs(login, profile);
    const res = await createEpisodeAction(
      fd({
        situation: "Illness",
        startDate: "2026-03-01",
        endDate: "2026-03-05",
      })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const row = getEpisodeRow(profile.id, res.id)!;
    expect(row.start_date).toBe("2026-03-01");
    expect(row.end_date).toBe("2026-03-05");
  });

  it("merges a flap-split pair into the union range, deleting the loser", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Merge", login.id);
    actAs(login, profile);
    const a = createEpisodeRowFor(profile.id, "2026-02-01", "2026-02-02");
    const b = createEpisodeRowFor(profile.id, "2026-02-02", "2026-02-06");
    await promoteEpisodeToConditionAction(fd({ episodeId: b }));
    const res = await mergeEpisodesAction(fd({ keepId: a, dropId: b }));
    expect(res.ok).toBe(true);
    const keeper = getEpisodeRow(profile.id, a)!;
    expect(keeper.start_date).toBe("2026-02-01");
    expect(keeper.end_date).toBe("2026-02-06");
    expect(getEpisodeRow(profile.id, b)).toBeNull();
    expect(listEpisodeRows(profile.id).length).toBe(1);
    const condition = db
      .prepare(
        `SELECT onset_date, resolved_date, external_id
           FROM conditions WHERE profile_id = ? AND source = 'episode'`
      )
      .get(profile.id) as {
      onset_date: string;
      resolved_date: string;
      external_id: string;
    };
    expect(condition.external_id).toBe(`illness-episode:${a}`);
    expect(condition.onset_date).toBe("2026-02-01");
    // Resolved ON the union's inclusive last active day.
    expect(condition.resolved_date).toBe("2026-02-06");
  });
});

describe("createEpisodeShareLinkAction", () => {
  it("mints an episode-kind share link resolvable by token, anchored to the id", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Share Actor", login.id);
    actAs(login, profile);
    const episodeId = makeSick(profile.id);

    const res = await createEpisodeShareLinkAction(
      fd({ episodeId, ttl: "7d" })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const token = res.path.replace("/share/", "");
    const link = getShareLinkByToken(token)!;
    expect(link.kind).toBe("episode");
    expect(link.profile_id).toBe(profile.id);
    expect(link.episode_id).toBe(episodeId);
    expect(link.episode_situation).toBe("Illness");
    expect(link.revoked_at).toBeNull();
  });

  it("is blocked for a read-only acting session", async () => {
    const login = createLogin({ role: "member" });
    const profile = createProfile("RO Actor", login.id);
    actAs(login, profile, "read");
    // makeSick uses profile writes; do it as write first, then downgrade.
    actAs(login, profile, "write");
    const episodeId = makeSick(profile.id);
    actAs(login, profile, "read");
    await expect(
      createEpisodeShareLinkAction(fd({ episodeId, ttl: "7d" }))
    ).rejects.toThrow(/read-only/);
  });
});

describe("episode event ledger actions", () => {
  it("edits and deletes temperature and PRN-dose history within the active profile", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Event Editor", login.id);
    actAs(login, profile);
    // Deterministic occurred_at math whatever zone the host runs in: the
    // corrected reading time below resolves on the profile's own wall clock.
    db.prepare(
      "INSERT OR REPLACE INTO profile_settings (profile_id, key, value) VALUES (?, 'timezone', 'UTC')"
    ).run(profile.id);
    const episodeId = makeSick(profile.id);
    const date = today(profile.id);

    const temperature = logTemperatureCore(
      profile.id,
      101.2,
      "F",
      date,
      "08:15"
    );
    expect(temperature.kind).toBe("logged");
    if (temperature.kind !== "logged") return;

    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Test fever reducer', 1, 'medication', 'daily', 'may')`
        )
        .run(profile.id).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses
             (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '100 mg', 'Anytime', 'any', 0)`
        )
        .run(itemId).lastInsertRowid
    );
    const logId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_logs
             (dose_id, item_id, date, recorded_at, amount, status)
           VALUES (?, ?, ?, '2026-01-01 14:00:00', '100 mg', 'taken')`
        )
        .run(doseId, itemId, date).lastInsertRowid
    );

    expect(
      await updateEpisodeTemperatureAction(
        fd({
          episodeId,
          eventId: temperature.id,
          date,
          time: "09:45",
          value: "38",
          unit: "C",
        })
      )
    ).toEqual({ ok: true });
    // The corrected reading time lands on the row's own occurred_at (#2154 —
    // the retired notes-"HH:MM" convention is never written again), resolved on
    // the profile's wall clock (UTC in this harness).
    expect(
      db
        .prepare(
          "SELECT value_num, occurred_at, notes FROM medical_records WHERE id = ? AND profile_id = ?"
        )
        .get(temperature.id, profile.id)
    ).toMatchObject({
      value_num: 100.4,
      occurred_at: `${date}T09:45:00Z`,
      notes: null,
    });

    expect(
      await updateEpisodeSymptomAction(
        fd({
          episodeId,
          date,
          symptom: "cough",
          severity: 4,
          note: "Worse after dinner",
        })
      )
    ).toEqual({ ok: true });
    expect(
      db
        .prepare(
          `SELECT severity, note FROM symptom_logs
            WHERE profile_id = ? AND date = ? AND symptom = ?`
        )
        .get(profile.id, date, "cough")
    ).toEqual({ severity: 4, note: "Worse after dinner" });

    // A fully past day inside the episode (started two days ago), so the stated
    // 10:30 can never trip the amend core's future guard whatever real hour the
    // test tier runs at.
    const doseDate = shiftDateStr(date, -1);
    expect(
      await updateEpisodeDoseAction(
        fd({
          episodeId,
          eventId: logId,
          date: doseDate,
          time: "10:30",
          amount: "200 mg",
        })
      )
    ).toEqual({ ok: true });
    // The stated time lands in occurred_at through the ONE amend core (#2228
    // decision 6); recorded_at is record history and keeps its original stamp.
    expect(
      db
        .prepare(
          `SELECT l.amount, l.date, l.occurred_at, l.recorded_at
             FROM intake_item_logs l
             JOIN intake_items i ON i.id = l.item_id
            WHERE l.id = ? AND i.profile_id = ?`
        )
        .get(logId, profile.id)
    ).toMatchObject({
      amount: "200 mg",
      date: doseDate,
      recorded_at: "2026-01-01 14:00:00",
    });
    expect(
      (
        db
          .prepare(`SELECT occurred_at FROM intake_item_logs WHERE id = ?`)
          .get(logId) as { occurred_at: string }
      ).occurred_at
    ).toContain("10:30");
    // The same clinically significant rewrite records the same audit row the
    // medication card's amendment does.
    expect(
      db
        .prepare(
          `SELECT detail FROM audit_events
            WHERE action = 'dose-log.amend' AND target = ?
              AND active_profile_id = ?`
        )
        .get(String(itemId), profile.id)
    ).toMatchObject({ detail: doseDate });

    expect(
      (
        await deleteEpisodeTemperatureAction(
          fd({ episodeId, eventId: temperature.id })
        )
      ).undoId
    ).toBeTypeOf("number");
    expect(
      (await deleteEpisodeDoseAction(fd({ episodeId, eventId: logId }))).undoId
    ).toBeTypeOf("number");
  });

  it("episode amendments obey the shared amend rules: near-duplicate refused, may-course extended on backdate", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Amend Rules", login.id);
    actAs(login, profile);
    const episodeId = makeSick(profile.id); // starts two days ago, open
    const date = today(profile.id);
    const yesterday = shiftDateStr(date, -1);
    const firstDay = shiftDateStr(date, -2);

    // A `may` medication WITH a course that begins yesterday — the shape whose
    // rules updateAdministrationLog silently skipped (#2228 §2).
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation)
           VALUES (?, 'Course-bound reliever', 1, 'medication', 'as needed', 'may')`
        )
        .run(profile.id).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses
             (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '100 mg', 'Anytime', 'any', 0)`
        )
        .run(itemId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO medication_courses (item_id, started_on, stopped_on)
       VALUES (?, ?, NULL)`
    ).run(itemId, yesterday);
    const insertLog = db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, recorded_at, amount, status)
       VALUES (?, ?, ?, ?, '100 mg', 'taken')`
    );
    insertLog.run(doseId, itemId, yesterday, `${yesterday} 08:00:00`);
    const logId = Number(
      insertLog.run(doseId, itemId, yesterday, `${yesterday} 12:00:00`)
        .lastInsertRowid
    );

    // Stating a time within the proximity window of the sibling's recorded_at is now
    // refused from the episode surface — identically to the medication card.
    expect(
      await updateEpisodeDoseAction(
        fd({ episodeId, eventId: logId, date: yesterday, time: "08:01" })
      )
    ).toEqual({
      ok: false,
      error: "A dose is already recorded at about this time.",
    });

    // Backdating before the course start now extends the `may` course — the
    // intended consequence of routing through the one core (#2228 decision 6).
    expect(
      await updateEpisodeDoseAction(
        fd({ episodeId, eventId: logId, date: firstDay, time: "07:00" })
      )
    ).toEqual({ ok: true });
    expect(
      (
        db
          .prepare(
            `SELECT started_on FROM medication_courses WHERE item_id = ?`
          )
          .get(itemId) as { started_on: string }
      ).started_on
    ).toBe(firstDay);
    expect(
      db
        .prepare(
          `SELECT detail FROM audit_events
            WHERE action = 'dose-log.amend' AND target = ?
              AND active_profile_id = ?`
        )
        .get(String(itemId), profile.id)
    ).toMatchObject({ detail: firstDay });
  });

  it("rejects moving an event outside its episode", async () => {
    const login = createLogin({ role: "admin" });
    const profile = createProfile("Range Guard", login.id);
    actAs(login, profile);
    const episodeId = makeSick(profile.id);
    const reading = logTemperatureCore(
      profile.id,
      99.8,
      "F",
      today(profile.id),
      "08:00"
    );
    expect(reading.kind).toBe("logged");
    if (reading.kind !== "logged") return;
    const result = await updateEpisodeTemperatureAction(
      fd({
        episodeId,
        eventId: reading.id,
        date: "2020-01-01",
        time: "08:00",
        value: "99.8",
      })
    );
    expect(result.ok).toBe(false);
    expect(
      (
        await updateEpisodeSymptomAction(
          fd({
            episodeId,
            date: "2020-01-01",
            symptom: "cough",
            severity: 3,
          })
        )
      ).ok
    ).toBe(false);
  });

  it("edits and deletes events for an explicitly targeted writable profile", async () => {
    const login = createLogin({ role: "member" });
    const acting = createProfile("Caregiver profile", login.id);
    const subject = createProfile("Event subject", login.id);
    actAs(login, acting);
    const episodeId = makeSick(subject.id);
    const date = today(subject.id);
    const temperature = logTemperatureCore(
      subject.id,
      101.2,
      "F",
      date,
      "08:15"
    );
    expect(temperature.kind).toBe("logged");
    if (temperature.kind !== "logged") return;

    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Cross-profile fever reducer', 1, 'medication', 'daily', 'may')`
        )
        .run(subject.id).lastInsertRowid
    );
    const doseId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses
             (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '100 mg', 'Anytime', 'any', 0)`
        )
        .run(itemId).lastInsertRowid
    );
    const logId = Number(
      db
        .prepare(
          `INSERT INTO intake_item_logs
             (dose_id, item_id, date, recorded_at, amount, status)
           VALUES (?, ?, ?, '2026-01-01 14:00:00', '100 mg', 'taken')`
        )
        .run(doseId, itemId, date).lastInsertRowid
    );

    expect(
      await updateEpisodeTemperatureAction(
        fd({
          profileId: subject.id,
          episodeId,
          eventId: temperature.id,
          date,
          time: "09:45",
          value: "100.4",
          unit: "F",
        })
      )
    ).toEqual({ ok: true });
    expect(
      await updateEpisodeDoseAction(
        fd({
          profileId: subject.id,
          episodeId,
          eventId: logId,
          // A past in-episode day, so the stated time can't read as future.
          date: shiftDateStr(date, -1),
          time: "10:30",
          amount: "200 mg",
        })
      )
    ).toEqual({ ok: true });
    expect(
      await updateEpisodeSymptomAction(
        fd({
          profileId: subject.id,
          episodeId,
          date,
          symptom: "cough",
          severity: 3,
          note: "Caregiver update",
        })
      )
    ).toEqual({ ok: true });

    expect(
      (
        await deleteEpisodeTemperatureAction(
          fd({
            profileId: subject.id,
            episodeId,
            eventId: temperature.id,
          })
        )
      ).undoId
    ).toBeTypeOf("number");
    expect(
      (
        await deleteEpisodeDoseAction(
          fd({ profileId: subject.id, episodeId, eventId: logId })
        )
      ).undoId
    ).toBeTypeOf("number");
  });
});
