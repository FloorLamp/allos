// DB INTEGRATION TIER (issue #856) — the episodes-table MODEL swap.
//
// Item 0's acceptance: the migration backfills one illness_episodes row per historical
// flagged on→off range from the situation change-log; the derived assembly is identical
// pre/post the model swap; and the flagged-situation toggle opens/closes rows in ONE
// writeTx so the active set and the open row never disagree. Deterministic :memory: DB.
//
// The frozen 046/062 helpers run against the PRE-169 schema (`started_at`/`ended_at`),
// so the tests that drive them build that legacy shape in their own :memory: database
// — the live db here is migrated past 169 and no longer has those columns.

import Database from "better-sqlite3";
import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { backfillIllnessEpisodes } from "@/lib/migrations/versions/046-illness-episodes";
import { stabilizeEpisodeConditions } from "@/lib/migrations/versions/062-stable-episode-conditions";
import { up as up169 } from "@/lib/migrations/versions/169-illness-episode-day-window";
import { shiftDateStr } from "@/lib/date";
import { createEpisodeRow } from "@/lib/illness-episode-store";
import {
  episodeForProfileDate,
  assembleIllnessEpisode,
} from "@/lib/illness-episode";
import { summarizeEpisodesForProfile } from "@/lib/illness-episode-summary";
import { episodesForSituation, episodeForDate } from "@/lib/symptom-episode";
import {
  getOpenEpisodeRow,
  listEpisodeRows,
  episodeRowToDerived,
} from "@/lib/illness-episode-store";
import { getConditions } from "@/lib/queries";
import {
  resolveSituationId,
  setProfileSetting,
  setActiveSituations,
} from "@/lib/settings";
import {
  serializeSituationEvents,
  type SituationEvent,
} from "@/lib/trend-annotations";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// Flag "Illness" as illness-type, set its active state, and seed a change-log.
function seedLog(p: number, active: boolean, events: SituationEvent[]) {
  resolveSituationId(p, "Illness"); // born illness_type = 1
  db.prepare(
    `UPDATE situations SET active = ? WHERE profile_id = ? AND name = 'Illness'`
  ).run(active ? 1 : 0, p);
  setProfileSetting(
    p,
    "situation_events",
    serializeSituationEvents([], events)
  );
}

// The pre-169 illness_episodes shape the frozen 046/062 helpers were written against,
// plus whatever sibling tables each helper reads.
function legacyEpisodeDb(): Database.Database {
  const mem = new Database(":memory:");
  mem.exec(`
    CREATE TABLE profiles (id INTEGER PRIMARY KEY, name TEXT NOT NULL);
    CREATE TABLE illness_episodes (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL REFERENCES profiles(id),
      situation  TEXT NOT NULL,
      started_at TEXT,
      ended_at   TEXT,
      note       TEXT,
      outcome    TEXT
    );
  `);
  mem.pragma("foreign_keys = OFF");
  return mem;
}

describe("stable episode-condition migration (#856 corrective)", () => {
  it("re-anchors a legacy promotion and repairs its resolved range", () => {
    const mem = legacyEpisodeDb();
    mem.exec(`
      CREATE TABLE conditions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        status TEXT,
        onset_date TEXT,
        resolved_date TEXT,
        source TEXT,
        external_id TEXT
      );
      INSERT INTO profiles (id, name) VALUES (1, 'Legacy');
    `);
    const episodeId = Number(
      mem
        .prepare(
          `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
           VALUES (1, 'Illness', '2026-04-01', '2026-04-05')`
        )
        .run().lastInsertRowid
    );
    mem
      .prepare(
        `INSERT INTO conditions
           (profile_id, name, status, onset_date, resolved_date, source, external_id)
         VALUES (1, 'Illness', 'active', '2026-04-01', NULL, 'episode',
                 'episode:illness:2026-04-01')`
      )
      .run();

    stabilizeEpisodeConditions(mem);

    const condition = mem
      .prepare(
        `SELECT status, onset_date, resolved_date, external_id
           FROM conditions WHERE profile_id = 1 AND source = 'episode'`
      )
      .get() as {
      status: string;
      onset_date: string;
      resolved_date: string;
      external_id: string;
    };
    expect(condition.external_id).toBe(`illness-episode:${episodeId}`);
    expect(condition.status).toBe("resolved");
    expect(condition.onset_date).toBe("2026-04-01");
    // 062 ran against the EXCLUSIVE ended_at era, so it resolved on end-1 — the value
    // migration 169 later carries forward unchanged (conditions are not rewritten).
    expect(condition.resolved_date).toBe("2026-04-04");
  });
});

describe("illness_episodes backfill (#856 item 0) through the #2232 conversion", () => {
  it("046's stop-day rows land as inclusive last-active days after 169", () => {
    // 046's backfill writes the change-log's stop-event shape into a pre-169 schema;
    // 169 then converts every non-NULL end to the inclusive last active day. The two
    // are tested TOGETHER because that pairing is exactly why episodesForSituation
    // must keep emitting the stop day (a from-scratch replay runs both).
    const mem = legacyEpisodeDb();
    mem.exec(`
      CREATE TABLE situations (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        profile_id INTEGER NOT NULL,
        name TEXT NOT NULL,
        active INTEGER NOT NULL DEFAULT 0,
        illness_type INTEGER NOT NULL DEFAULT 0
      );
      CREATE TABLE profile_settings (
        profile_id INTEGER NOT NULL, key TEXT NOT NULL, value TEXT NOT NULL,
        PRIMARY KEY (profile_id, key)
      );
      INSERT INTO profiles (id, name) VALUES (1, 'Backfill');
      INSERT INTO situations (profile_id, name, active, illness_type)
        VALUES (1, 'Illness', 1, 1);
    `);
    // Two closed ranges + one open (currently active).
    const events: SituationEvent[] = [
      { date: "2026-01-05", situation: "Illness", change: "start" },
      { date: "2026-01-10", situation: "Illness", change: "stop" },
      { date: "2026-03-01", situation: "Illness", change: "start" },
      { date: "2026-03-04", situation: "Illness", change: "stop" },
      { date: "2026-06-01", situation: "Illness", change: "start" },
    ];
    mem
      .prepare(
        `INSERT INTO profile_settings (profile_id, key, value)
         VALUES (1, 'situation_events', ?)`
      )
      .run(serializeSituationEvents([], events));

    backfillIllnessEpisodes(mem);
    up169(mem);

    const rows = mem
      .prepare(
        `SELECT start_date, end_date FROM illness_episodes
          WHERE profile_id = 1 ORDER BY start_date`
      )
      .all() as { start_date: string | null; end_date: string | null }[];
    // The reference: each run's stop day, converted to the inclusive last active day.
    const expected = episodesForSituation("Illness", events, true).map((d) => ({
      start_date: d.start,
      end_date: d.end == null ? null : shiftDateStr(d.end, -1),
    }));
    expect(rows).toEqual(expected);
    // Exactly one open row (the ongoing range).
    expect(rows.filter((r) => r.end_date == null).length).toBe(1);
  });

  it("episodeForProfileDate matches the pure derivation for the same log", () => {
    const p = newProfile("parity");
    const events: SituationEvent[] = [
      { date: "2026-02-02", situation: "Illness", change: "start" },
      { date: "2026-02-07", situation: "Illness", change: "stop" },
    ];
    seedLog(p, false, events);
    // The stored rows a 046→169 replay would produce: the run's stop day, converted
    // to the inclusive last active day.
    for (const run of episodesForSituation("Illness", events, false)) {
      createEpisodeRow(
        p,
        "Illness",
        run.start,
        run.end == null ? null : shiftDateStr(run.end, -1)
      );
    }

    for (const date of ["2026-02-02", "2026-02-05", "2026-02-06"]) {
      const rowEp = episodeForProfileDate(p, date);
      const derivedEp = episodeForDate(
        date,
        [{ name: "Illness", active: false }],
        events
      );
      expect(rowEp?.start ?? null).toBe(derivedEp?.start ?? null);
      expect(rowEp?.end ?? null).toBe(derivedEp?.end ?? null);
      // The assembled model is byte-identical when the range matches.
      if (rowEp && derivedEp) {
        const a = assembleIllnessEpisode(p, rowEp);
        const b = assembleIllnessEpisode(p, {
          ...derivedEp,
          id: rowEp.id,
        });
        expect(a).toEqual(b);
      }
    }
    // 2026-02-07 is the stop day — the first inactive day → no episode.
    expect(episodeForProfileDate(p, "2026-02-07")).toBeNull();
  });
});

describe("toggle opens/closes rows in one write path (#856 item 0)", () => {
  it("activating an illness situation opens a row; deactivating closes it", () => {
    const p = newProfile("toggle");
    resolveSituationId(p, "Illness"); // illness-type

    // Activate → an open row appears.
    setActiveSituations(p, ["Illness"]);
    const open = getOpenEpisodeRow(p, "Illness");
    expect(open).not.toBeNull();
    expect(open!.end_date).toBeNull();

    // Re-activating (no change) does not open a second row.
    setActiveSituations(p, ["Illness"]);
    expect(listEpisodeRows(p).length).toBe(1);

    // Deactivate → the open row is stamped closed.
    setActiveSituations(p, []);
    expect(getOpenEpisodeRow(p, "Illness")).toBeNull();
    const rows = listEpisodeRows(p);
    expect(rows.length).toBe(1);
    expect(rows[0].end_date).not.toBeNull();

    // A fresh activation opens a NEW distinct row (flap = two episodes).
    setActiveSituations(p, ["Illness"]);
    expect(listEpisodeRows(p).length).toBe(2);
  });

  it("a non-illness situation never opens an episode row", () => {
    const p = newProfile("non-illness");
    setActiveSituations(p, ["Travel"]);
    expect(listEpisodeRows(p).length).toBe(0);
  });
});

describe("summarizeEpisodesForProfile hoists getConditions once (#886)", () => {
  it("produces summaries identical to per-episode assembly over a multi-episode fixture", () => {
    const p = newProfile("multi-episode");
    // Three historical episodes (two closed + one open).
    const events: SituationEvent[] = [
      { date: "2026-01-05", situation: "Illness", change: "start" },
      { date: "2026-01-12", situation: "Illness", change: "stop" },
      { date: "2026-03-01", situation: "Illness", change: "start" },
      { date: "2026-03-06", situation: "Illness", change: "stop" },
      { date: "2026-06-01", situation: "Illness", change: "start" },
    ];
    seedLog(p, true, events);
    // The stored rows a 046→169 replay would produce (see the parity test above).
    for (const run of episodesForSituation("Illness", events, true)) {
      createEpisodeRow(
        p,
        "Illness",
        run.start,
        run.end == null ? null : shiftDateStr(run.end, -1)
      );
    }

    // A few conditions: one whose onset falls inside the second episode's window, and a
    // couple outside — enough that the per-episode filter has real work, and the batched
    // getConditions must return the same set the per-episode call would.
    const insCond = db.prepare(
      `INSERT INTO conditions (profile_id, name, status, onset_date)
       VALUES (?, ?, ?, ?)`
    );
    insCond.run(p, "Sinusitis", "active", "2026-03-03");
    insCond.run(p, "Seasonal allergies", "active", "2025-11-01");
    insCond.run(p, "Bronchitis", "resolved", "2026-01-08");

    // A temperature reading inside the second episode's window so an assembly carries a
    // real maxTempF (canonical_name matches VITAL_CANONICAL.temperature.canonical).
    db.prepare(
      `INSERT INTO medical_records (profile_id, category, name, canonical_name, date, value_num)
       VALUES (?, 'vitals', 'Temperature', 'Body Temperature', '2026-03-03', 101.2)`
    ).run(p);

    // Reference: the OLD behavior — assemble each row WITHOUT a preset condition list
    // (each call fetches getConditions itself). The hoisted path must match it exactly.
    const reference = listEpisodeRows(p).map((row) => {
      const assembled = assembleIllnessEpisode(p, episodeRowToDerived(row));
      const promoted = assembled.conditions.find((c) => c.fromEpisode) ?? null;
      return {
        id: row.id,
        situation: assembled.situation,
        start: assembled.start,
        end: assembled.end,
        ongoing: assembled.ongoing,
        firstDay: assembled.firstDay,
        lastActiveDay: assembled.lastActiveDay,
        dayCount: assembled.dayCount,
        maxTempF: assembled.maxTempF,
        symptomLabels: assembled.symptoms.map((s) => s.label),
        distinctSymptomCount: assembled.distinctSymptomCount,
        totalAdministrations: assembled.totalAdministrations,
        outcome: row.outcome,
        promotedConditionName: promoted ? promoted.name : null,
      };
    });

    expect(summarizeEpisodesForProfile(p)).toEqual(reference);
    // Sanity: the fixture actually produced multiple episodes and saw the conditions.
    expect(reference.length).toBeGreaterThanOrEqual(3);
    expect(getConditions(p).length).toBe(3);
  });
});
