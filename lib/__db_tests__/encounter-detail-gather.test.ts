// DB INTEGRATION TIER (#1350, the #448 builder discipline): the encounter-detail
// gathers — the illness-episode care trail + encounter-side link suggestion, the
// scheduling-origin appointment, and the visit context. Each gathers DB state and
// hands a pure engine its input, so it carries a fixture asserting end-to-end output.
// Two members: every gather must stay profile-scoped (a neighbor's visit/episode never
// leaks). Deterministic :memory: DB via setup.ts; fixed dates.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import {
  episodesForEncounter,
  episodeSuggestionForEncounter,
  appointmentForEncounter,
  visitContextForEncounter,
  linkEpisodeToEncounter,
} from "@/lib/queries";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function newProvider(name: string): number {
  return Number(
    db
      .prepare(
        `INSERT INTO providers (name, type, dedup_key) VALUES (?, 'individual', ?)`
      )
      .run(name, `dk:${name}`).lastInsertRowid
  );
}

function newEncounter(
  profileId: number,
  date: string,
  providerId: number | null,
  classCode: string
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO encounters (profile_id, date, type, class_code, provider_id)
         VALUES (?, ?, 'Office Visit', ?, ?)`
      )
      .run(profileId, date, classCode, providerId).lastInsertRowid
  );
}

function newEpisode(
  profileId: number,
  situation: string,
  startedAt: string,
  endedAt: string | null
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
         VALUES (?, ?, ?, ?)`
      )
      .run(profileId, situation, startedAt, endedAt).lastInsertRowid
  );
}

describe("encounter-detail gathers (#1350)", () => {
  it("trails linked episodes, suggests in-range unlinked ones, and scopes by profile", () => {
    const A = newProfile("Ada");
    const B = newProfile("Bo");
    const patel = newProvider("Dr. Patel");

    // Profile A: an earlier + a subject visit with the same provider, an episode whose
    // range contains the subject visit, and a booked appointment.
    newEncounter(A, "2026-03-02", patel, "AMB");
    const subject = newEncounter(A, "2026-06-18", patel, "AMB");
    // Episode active 2026-06-15 .. 2026-06-22 (ended_at is the EXCLUSIVE stop day).
    const ep = newEpisode(A, "sinus infection", "2026-06-15", "2026-06-23");
    db.prepare(
      `INSERT INTO appointments (profile_id, scheduled_at, provider_id, status, encounter_id, title)
       VALUES (?, '2026-06-10 09:00:00', ?, 'completed', ?, 'Follow-up')`
    ).run(A, patel, subject);

    // Profile B: an overlapping episode + its own visit — must NEVER leak into A.
    const bVisit = newEncounter(B, "2026-06-18", null, "AMB");
    newEpisode(B, "flu", "2026-06-15", "2026-06-23");
    db.prepare(
      `INSERT INTO appointments (profile_id, scheduled_at, status, encounter_id, title)
       VALUES (?, '2026-06-01 09:00:00', 'completed', ?, 'B appt')`
    ).run(B, bVisit);

    // Before any link: no trail, but the in-range episode is suggested.
    expect(episodesForEncounter(A, subject)).toEqual([]);
    const before = episodeSuggestionForEncounter(A, subject);
    expect(before?.episode?.id).toBe(ep);
    expect(before?.episode?.situation).toBe("sinus infection");
    expect(before?.candidates).toBeUndefined();

    // Scheduling origin: the completed appointment booked for this visit.
    const appt = appointmentForEncounter(A, subject);
    expect(appt?.scheduled_at.slice(0, 10)).toBe("2026-06-10");

    // Visit context: 2nd visit with Dr. Patel (prior 2026-03-02), 2nd ambulatory
    // visit this year.
    const ctx = visitContextForEncounter(A, subject);
    expect(ctx?.provider).toEqual({
      name: "Dr. Patel",
      ordinal: 2,
      priorDate: "2026-03-02",
    });
    expect(ctx?.kindYear).toEqual({ ordinal: 2 });

    // Profile isolation: A's episode suggestion never sees B's overlapping episode,
    // and B's appointment never answers for A's visit.
    const bSuggestSituations = (() => {
      const s = episodeSuggestionForEncounter(A, subject);
      return [
        ...(s?.episode ? [s.episode.situation] : []),
        ...(s?.candidates ?? []).map((c) => c.situation),
      ];
    })();
    expect(bSuggestSituations).not.toContain("flu");
    // A cannot open B's visit at all (profile-scoped read).
    expect(appointmentForEncounter(B, subject)).toBeNull();
    expect(visitContextForEncounter(B, subject)).toBeNull();

    // After linking: the episode joins the trail and drops out of the suggestion.
    expect(linkEpisodeToEncounter(A, ep, subject)).toBe(true);
    const trail = episodesForEncounter(A, subject);
    expect(trail.map((t) => t.id)).toEqual([ep]);
    expect(trail[0].situation).toBe("sinus infection");
    expect(episodeSuggestionForEncounter(A, subject)).toBeNull();
    // B's trail for its own visit stays empty — the link didn't cross profiles.
    expect(episodesForEncounter(B, bVisit)).toEqual([]);
  });

  it("gives no visit context for a genuine first visit", () => {
    const P = newProfile("Cy");
    const solo = newEncounter(P, "2026-05-01", newProvider("Dr. Solo"), "AMB");
    const ctx = visitContextForEncounter(P, solo);
    expect(ctx?.provider).toBeNull();
    expect(ctx?.kindYear).toBeNull();
  });
});
