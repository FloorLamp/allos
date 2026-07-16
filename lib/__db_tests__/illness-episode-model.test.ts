// DB INTEGRATION TIER (issue #856) — the episodes-table MODEL swap.
//
// Item 0's acceptance: the migration backfills one illness_episodes row per historical
// flagged on→off range from the situation change-log; the derived assembly is identical
// pre/post the model swap; and the flagged-situation toggle opens/closes rows in ONE
// writeTx so the active set and the open row never disagree. Deterministic :memory: DB.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { backfillIllnessEpisodes } from "@/lib/migrations/versions/046-illness-episodes";
import {
  episodeForProfileDate,
  assembleIllnessEpisode,
} from "@/lib/illness-episode";
import { episodesForSituation, episodeForDate } from "@/lib/symptom-episode";
import {
  getOpenEpisodeRow,
  listEpisodeRows,
} from "@/lib/illness-episode-store";
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

describe("illness_episodes backfill (#856 item 0)", () => {
  it("reconstructs one row per historical flagged on→off range", () => {
    const p = newProfile("backfill");
    // Two closed ranges + one open (currently active). Exclusive end = the stop date.
    const events: SituationEvent[] = [
      { date: "2026-01-05", situation: "Illness", change: "start" },
      { date: "2026-01-10", situation: "Illness", change: "stop" },
      { date: "2026-03-01", situation: "Illness", change: "start" },
      { date: "2026-03-04", situation: "Illness", change: "stop" },
      { date: "2026-06-01", situation: "Illness", change: "start" },
    ];
    seedLog(p, true, events);
    // No rows created by the (empty-at-migration-time) backfill; drive it now.
    backfillIllnessEpisodes(db);

    const rows = listEpisodeRows(p);
    // Derived enumeration is the reference.
    const derived = episodesForSituation("Illness", events, true);
    expect(rows.length).toBe(derived.length);
    // Rows carry the SAME (start, end) as the derivation (identity, oldest→newest).
    const rowRanges = rows
      .map((r) => `${r.started_at ?? "null"}..${r.ended_at ?? "open"}`)
      .sort();
    const derivedRanges = derived
      .map((d) => `${d.start ?? "null"}..${d.end ?? "open"}`)
      .sort();
    expect(rowRanges).toEqual(derivedRanges);
    // Exactly one open row (the ongoing range).
    expect(rows.filter((r) => r.ended_at == null).length).toBe(1);
  });

  it("episodeForProfileDate matches the pure derivation for the same log", () => {
    const p = newProfile("parity");
    const events: SituationEvent[] = [
      { date: "2026-02-02", situation: "Illness", change: "start" },
      { date: "2026-02-07", situation: "Illness", change: "stop" },
    ];
    seedLog(p, false, events);
    backfillIllnessEpisodes(db);

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
    // 2026-02-07 is the exclusive stop day → inactive → no episode.
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
    expect(open!.ended_at).toBeNull();

    // Re-activating (no change) does not open a second row.
    setActiveSituations(p, ["Illness"]);
    expect(listEpisodeRows(p).length).toBe(1);

    // Deactivate → the open row is stamped closed.
    setActiveSituations(p, []);
    expect(getOpenEpisodeRow(p, "Illness")).toBeNull();
    const rows = listEpisodeRows(p);
    expect(rows.length).toBe(1);
    expect(rows[0].ended_at).not.toBeNull();

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
