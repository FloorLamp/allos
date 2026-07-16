// DB INTEGRATION TIER (issue #856 items 7-8, 10) — the derived, no-FK clinical-event
// association for an illness episode, and the historical-duration comparison. Both gather
// DB state over the episode's date window, so they carry a fixture asserting end-to-end
// output. Deterministic :memory: DB.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { getEpisodeInRangeEvents } from "@/lib/illness-episode-events";
import { episodeComparisonFor } from "@/lib/illness-episode-compare";
import { today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

describe("getEpisodeInRangeEvents (#856 items 7-8)", () => {
  it("gathers only the encounters/appointments/courses/documents inside the window", () => {
    const p = newProfile("assoc");
    const from = "2026-06-01";
    const to = "2026-06-05";

    // In-range encounter + one outside.
    db.prepare(
      `INSERT INTO encounters (profile_id, date, type, reason) VALUES (?, '2026-06-03', 'Office visit', 'cough')`
    ).run(p);
    db.prepare(
      `INSERT INTO encounters (profile_id, date, type, reason) VALUES (?, '2026-07-01', 'Office visit', 'unrelated')`
    ).run(p);

    // In-range appointment.
    db.prepare(
      `INSERT INTO appointments (profile_id, scheduled_at, title) VALUES (?, '2026-06-04 09:00:00', 'Follow-up')`
    ).run(p);

    // Medication course started in-range (reaches profile via intake_items).
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority)
           VALUES (?, 'Amoxicillin', 1, 'medication', 'daily', 'high')`
        )
        .run(p).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO medication_courses (item_id, started_on) VALUES (?, '2026-06-02')`
    ).run(itemId);
    // A course started BEFORE the window is excluded.
    db.prepare(
      `INSERT INTO medication_courses (item_id, started_on) VALUES (?, '2026-01-01')`
    ).run(itemId);

    // Document dated in-range.
    db.prepare(
      `INSERT INTO medical_documents (profile_id, filename, stored_path, document_date)
       VALUES (?, 'visit-summary.pdf', '/x', '2026-06-03')`
    ).run(p);

    const ev = getEpisodeInRangeEvents(p, from, to);
    expect(ev.encounters.map((e) => e.reason)).toEqual(["cough"]);
    expect(ev.appointments.map((a) => a.title)).toEqual(["Follow-up"]);
    expect(ev.courses.map((c) => c.name)).toEqual(["Amoxicillin"]);
    expect(ev.documents.map((d) => d.filename)).toEqual(["visit-summary.pdf"]);
    expect(ev.total).toBe(4);
  });

  it("returns nothing for a null (unknown-start) window", () => {
    const p = newProfile("null-window");
    expect(getEpisodeInRangeEvents(p, null, "2026-06-05").total).toBe(0);
  });
});

describe("episodeComparisonFor (#856 item 10)", () => {
  it("compares an open episode's day-N against prior closed durations", () => {
    const p = newProfile("compare");
    // Two prior CLOSED episodes: 4-day and 6-day.
    db.prepare(
      `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
       VALUES (?, 'Illness', '2026-01-01', '2026-01-05')`
    ).run(p); // 4 days (end exclusive → last active 01-04 → 4 days)
    db.prepare(
      `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
       VALUES (?, 'Illness', '2026-03-01', '2026-03-07')`
    ).run(p); // 6 days
    // An OPEN episode started 3 days ago.
    const openId = Number(
      db
        .prepare(
          `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
           VALUES (?, 'Illness', ?, NULL)`
        )
        .run(p, shiftDateStr(today(p), -2)).lastInsertRowid
    );

    const c = episodeComparisonFor(p, openId)!;
    expect(c).not.toBeNull();
    expect(c.currentDay).toBe(3);
    expect(c.priorCount).toBe(2);
    expect(c.minDays).toBe(4);
    expect(c.maxDays).toBe(6);
  });

  it("is null with no prior closed episodes", () => {
    const p = newProfile("compare-none");
    const openId = Number(
      db
        .prepare(
          `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
           VALUES (?, 'Illness', ?, NULL)`
        )
        .run(p, shiftDateStr(today(p), -1)).lastInsertRowid
    );
    expect(episodeComparisonFor(p, openId)).toBeNull();
  });
});
