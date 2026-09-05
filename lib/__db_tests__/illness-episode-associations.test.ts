// DB INTEGRATION TIER (issue #856 items 7-8, 10) — the derived, no-FK clinical-event
// association for an illness episode, and the historical-duration comparison. Both gather
// DB state over the episode's date window, so they carry a fixture asserting end-to-end
// output. Deterministic :memory: DB.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { getEpisodeInRangeEvents } from "@/lib/illness-episode-events";
import { illnessCareTimelineEvents } from "@/lib/illness-timeline-view";
import { episodeComparisonFor } from "@/lib/illness-episode-compare";
import { today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  episodesForAppointments,
  episodesForConditions,
  episodesForDocument,
  episodesForMedication,
} from "@/lib/queries";

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
      `INSERT INTO appointments (profile_id, date, time_of_day, title) VALUES (?, '2026-06-04', '09:00', 'Follow-up')`
    ).run(p);

    // Medication course started in-range (reaches profile via intake_items).
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, condition, obligation)
         VALUES (?, 'Amoxicillin', 1, 'medication', 'daily', 'should')`
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

  it("keeps a CANCELLED appointment in the window, and the timeline names it (#2136)", () => {
    // The row is real history — the visit that fell through is often the reason an
    // illness ran on unseen — so it is gathered, not filtered. What must not survive
    // is the line that read "«title» scheduled" and asserted care that never happened.
    const p = newProfile("cancelled-appointment");
    db.prepare(
      `INSERT INTO appointments (profile_id, date, time_of_day, title, status)
       VALUES (?, '2026-06-04', '09:00', 'Paediatric follow-up', 'cancelled')`
    ).run(p);
    db.prepare(
      `INSERT INTO appointments (profile_id, date, time_of_day, title, status)
       VALUES (?, '2026-06-05', '11:00', 'Nurse check', 'scheduled')`
    ).run(p);

    const ev = getEpisodeInRangeEvents(p, "2026-06-01", "2026-06-05");
    expect(ev.appointments.map((a) => [a.title, a.status])).toEqual([
      ["Paediatric follow-up", "cancelled"],
      ["Nurse check", "scheduled"],
    ]);

    const lines = illnessCareTimelineEvents(ev)
      .filter((e) => e.kind === "appointment")
      .map((e) => ({ label: e.label, detail: e.detail }));
    expect(lines).toEqual([
      { label: "Appointment cancelled", detail: "Paediatric follow-up" },
      { label: "Appointment", detail: "Nurse check" },
    ]);
  });

  it("returns nothing for a null (unknown-start) window", () => {
    const p = newProfile("null-window");
    expect(getEpisodeInRangeEvents(p, null, "2026-06-05").total).toBe(0);
  });
});

describe("reverse episode associations (#856 items 7-8)", () => {
  it("returns the same appointment, course, document, and condition links from their own surfaces", () => {
    const p = newProfile("assoc-reverse");
    const other = newProfile("assoc-reverse-other");
    const episodeId = Number(
      db
        .prepare(
          `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
           VALUES (?, 'Flu', '2026-06-01', '2026-06-05')`
        )
        .run(p).lastInsertRowid
    );

    const appointmentId = Number(
      db
        .prepare(
          `INSERT INTO appointments (profile_id, date, title)
           VALUES (?, '2026-06-03', 'Same-day visit')`
        )
        .run(p).lastInsertRowid
    );
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, obligation)
           VALUES (?, 'Oseltamivir', 1, 'medication', 'daily', 'should')`
        )
        .run(p).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO medication_courses (item_id, started_on)
       VALUES (?, '2026-06-02')`
    ).run(itemId);
    const documentId = Number(
      db
        .prepare(
          `INSERT INTO medical_documents
             (profile_id, filename, stored_path, document_date)
           VALUES (?, 'flu-summary.pdf', '/x', '2026-06-04')`
        )
        .run(p).lastInsertRowid
    );
    const conditionId = Number(
      db
        .prepare(
          `INSERT INTO conditions
             (profile_id, name, status, source, external_id)
           VALUES (?, 'Flu', 'resolved', 'episode', ?)`
        )
        .run(p, `illness-episode:${episodeId}`).lastInsertRowid
    );
    const ordinaryConditionId = Number(
      db
        .prepare(
          `INSERT INTO conditions
             (profile_id, name, status, source, onset_date)
           VALUES (?, 'Post-viral cough', 'active', 'manual', '2026-06-03')`
        )
        .run(p).lastInsertRowid
    );
    const outsideConditionId = Number(
      db
        .prepare(
          `INSERT INTO conditions
             (profile_id, name, status, source, onset_date)
           VALUES (?, 'Old condition', 'active', 'manual', '2026-05-01')`
        )
        .run(p).lastInsertRowid
    );

    // Same dates under another profile must never leak into these readers.
    db.prepare(
      `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
       VALUES (?, 'Other illness', '2026-06-01', '2026-06-05')`
    ).run(other);

    expect(episodesForAppointments(p)[appointmentId]?.map((e) => e.id)).toEqual(
      [episodeId]
    );
    expect(episodesForMedication(p, itemId).map((e) => e.id)).toEqual([
      episodeId,
    ]);
    expect(episodesForDocument(p, documentId).map((e) => e.id)).toEqual([
      episodeId,
    ]);
    expect(episodesForConditions(p)[conditionId]?.map((e) => e.id)).toEqual([
      episodeId,
    ]);
    expect(
      episodesForConditions(p)[ordinaryConditionId]?.map((e) => e.id)
    ).toEqual([episodeId]);
    expect(episodesForConditions(p)[outsideConditionId]).toBeUndefined();
    expect(episodesForAppointments(other)[appointmentId]).toBeUndefined();
    expect(episodesForMedication(other, itemId)).toEqual([]);
    expect(episodesForDocument(other, documentId)).toEqual([]);
    expect(episodesForConditions(other)[conditionId]).toBeUndefined();
  });

  it("matches the detail window for unknown starts and open episodes", () => {
    const p = newProfile("assoc-window-rules");
    const asOf = today(p);
    const tomorrow = shiftDateStr(asOf, 1);
    db.prepare(
      `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
       VALUES (?, 'Unknown start', NULL, ?)`
    ).run(p, asOf);
    const openId = Number(
      db
        .prepare(
          `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
           VALUES (?, 'Current illness', ?, NULL)`
        )
        .run(p, asOf).lastInsertRowid
    );
    const todayAppointment = Number(
      db
        .prepare(
          `INSERT INTO appointments (profile_id, date, title)
           VALUES (?, ?, 'Today')`
        )
        .run(p, asOf).lastInsertRowid
    );
    const futureAppointment = Number(
      db
        .prepare(
          `INSERT INTO appointments (profile_id, date, title)
           VALUES (?, ?, 'Tomorrow')`
        )
        .run(p, tomorrow).lastInsertRowid
    );
    const todayCondition = Number(
      db
        .prepare(
          `INSERT INTO conditions
             (profile_id, name, status, source, onset_date)
           VALUES (?, 'Today condition', 'active', 'manual', ?)`
        )
        .run(p, asOf).lastInsertRowid
    );
    const futureCondition = Number(
      db
        .prepare(
          `INSERT INTO conditions
             (profile_id, name, status, source, onset_date)
           VALUES (?, 'Future condition', 'active', 'manual', ?)`
        )
        .run(p, tomorrow).lastInsertRowid
    );

    const links = episodesForAppointments(p);
    expect(links[todayAppointment]?.map((e) => e.id)).toEqual([openId]);
    expect(links[futureAppointment]).toBeUndefined();
    const conditionLinks = episodesForConditions(p);
    expect(conditionLinks[todayCondition]?.map((e) => e.id)).toEqual([openId]);
    expect(conditionLinks[futureCondition]).toBeUndefined();
  });
});

describe("episodeComparisonFor (#856 item 10)", () => {
  it("compares an open episode's day-N against prior closed durations", () => {
    const p = newProfile("compare");
    // Two prior CLOSED episodes: 4-day and 6-day.
    db.prepare(
      `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
       VALUES (?, 'Illness', '2026-01-01', '2026-01-04')`
    ).run(p); // 4 days (inclusive last active day 01-04)
    db.prepare(
      `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
       VALUES (?, 'Illness', '2026-03-01', '2026-03-06')`
    ).run(p); // 6 days
    // An OPEN episode started 3 days ago.
    const openId = Number(
      db
        .prepare(
          `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
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
    expect(c.medianDays).toBe(5);
  });

  it("states a whole number of days when the priors straddle a half", () => {
    // The line counts DAYS, so an even number of priors averaging 4.5 says five. The
    // module used to spell that with a private median of its own; it now reads the
    // shared habit model (#5143) and rounds where the counting happens.
    const p = newProfile("compare-half");
    for (const [start, end] of [
      ["2026-01-01", "2026-01-04"], // 4 days
      ["2026-03-01", "2026-03-05"], // 5 days
    ]) {
      db.prepare(
        `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
         VALUES (?, 'Illness', ?, ?)`
      ).run(p, start, end);
    }
    const openId = Number(
      db
        .prepare(
          `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
           VALUES (?, 'Illness', ?, NULL)`
        )
        .run(p, shiftDateStr(today(p), -1)).lastInsertRowid
    );
    expect(episodeComparisonFor(p, openId)!.medianDays).toBe(5);
  });

  it("is null with no prior closed episodes", () => {
    const p = newProfile("compare-none");
    const openId = Number(
      db
        .prepare(
          `INSERT INTO illness_episodes (profile_id, situation, start_date, end_date)
           VALUES (?, 'Illness', ?, NULL)`
        )
        .run(p, shiftDateStr(today(p), -1)).lastInsertRowid
    );
    expect(episodeComparisonFor(p, openId)).toBeNull();
  });
});
