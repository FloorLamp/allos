// DB INTEGRATION TIER (issue #801 — the builders-get-DB-tier-tests rule, #448).
//
// assembleIllnessEpisode GATHERS DB state (symptom series, temperature/fever curve,
// PRN administrations, bridged conditions) and hands it to the pure formatters, so it
// carries a DB-tier fixture asserting the END-TO-END assembled output — the pure tier
// can't see the SQL gather. Also exercises the cross-profile illness-hero access path
// (grants-scoped, #858) and the promote-to-condition write core + undo.
//
// Deterministic: :memory:-backed temp DB via setup.ts; fixed dates; no network.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { reconcileFlags } from "@/lib/queries";
import { logSymptomCore } from "@/lib/symptom-log-write";
import {
  assembleIllnessEpisode,
  currentEpisodeForProfile,
  openEpisodeForProfile,
} from "@/lib/illness-episode";
import {
  episodeHeadline,
  householdSickLine,
} from "@/lib/illness-episode-format";
import {
  promoteEpisodeToConditionCore,
  unpromoteEpisodeConditionCore,
} from "@/lib/illness-episode-write";
import { resolveSituationId, setProfileSetting } from "@/lib/settings";
import {
  serializeSituationEvents,
  type SituationEvent,
} from "@/lib/trend-annotations";
import { today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { resolveEpisodeAcrossProfiles } from "@/lib/illness-episode-store";
import type { IllnessEpisode } from "@/lib/symptom-episode";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function logTemp(profileId: number, date: string, time: string, degF: number) {
  const id = Number(
    db
      .prepare(
        `INSERT INTO medical_records
           (profile_id, date, category, name, value, value_num, unit,
            canonical_name, source, notes)
         VALUES (?, ?, 'vitals', 'Body Temperature', ?, ?, 'degF',
                 'Body Temperature', 'manual', ?)`
      )
      .run(profileId, date, String(degF), degF, time).lastInsertRowid
  );
  reconcileFlags(profileId, [id]);
}

// Create an as-needed (PRN) med with one dose; return item + dose ids.
function newPrnMed(
  profileId: number,
  name: string
): {
  itemId: number;
  doseId: number;
} {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, as_needed)
         VALUES (?, ?, 1, 'medication', 'daily', 'high', 1)`
      )
      .run(profileId, name).lastInsertRowid
  );
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '200 mg', 'any', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  return { itemId, doseId };
}

function logAdmin(
  doseId: number,
  itemId: number,
  date: string,
  amount: string
) {
  db.prepare(
    `INSERT INTO intake_item_logs (dose_id, item_id, date, given_at, amount, status)
     VALUES (?, ?, ?, ?, ?, 'taken')`
  ).run(doseId, itemId, date, `${date} 15:30:00`, amount);
}

// A closed 5-day episode 2026-06-01 .. 2026-06-05 (end EXCLUSIVE = 2026-06-06).
function seedFiveDayEpisode(profileId: number) {
  // Symptoms: cough all five days (easing), fever peaking mid-episode, one custom.
  logSymptomCore(profileId, "cough", 3, "2026-06-01");
  logSymptomCore(profileId, "fever", 2, "2026-06-01");
  logSymptomCore(profileId, "fever", 4, "2026-06-02");
  logSymptomCore(profileId, "cough", 3, "2026-06-02");
  logSymptomCore(profileId, "cough", 2, "2026-06-03", "loosening up");
  logSymptomCore(profileId, "Sinus headache", 2, "2026-06-03");
  logSymptomCore(profileId, "cough", 2, "2026-06-04");
  logSymptomCore(profileId, "cough", 1, "2026-06-05");

  // Fever curve: rises to a peak on 06-02, then trends down. >99°F flags 'high'.
  logTemp(profileId, "2026-06-01", "09:00", 99.6);
  logTemp(profileId, "2026-06-02", "08:00", 102.4); // peak
  logTemp(profileId, "2026-06-03", "09:00", 100.6);
  logTemp(profileId, "2026-06-04", "20:00", 99.8);
  logTemp(profileId, "2026-06-05", "08:00", 98.9); // back to normal (not a fever)

  // PRN ibuprofen 3× across the episode.
  const { itemId, doseId } = newPrnMed(profileId, "Ibuprofen");
  logAdmin(doseId, itemId, "2026-06-02", "200 mg");
  logAdmin(doseId, itemId, "2026-06-02", "200 mg");
  logAdmin(doseId, itemId, "2026-06-03", "400 mg");
}

const CLOSED: IllnessEpisode = {
  situation: "Illness",
  start: "2026-06-01",
  end: "2026-06-06", // exclusive
};

describe("assembleIllnessEpisode — 5-day fixture (#448)", () => {
  it("assembles symptom series, fever curve, PRN meds, and window bookkeeping", () => {
    const p = newProfile("five-day");
    seedFiveDayEpisode(p);
    const a = assembleIllnessEpisode(p, CLOSED);

    // Window: inclusive last active day = end-1; day count = 5.
    expect(a.firstDay).toBe("2026-06-01");
    expect(a.lastActiveDay).toBe("2026-06-05");
    expect(a.dayCount).toBe(5);
    expect(a.ongoing).toBe(false);

    // Symptoms: worst-first (fever sev 4, then cough sev 3, then Sinus headache).
    expect(a.distinctSymptomCount).toBe(3);
    expect(a.symptoms.map((s) => s.label)).toEqual([
      "Fever",
      "Cough",
      "Sinus headache",
    ]);
    const cough = a.symptoms.find((s) => s.symptom === "cough")!;
    expect(cough.points.map((pt) => pt.severity)).toEqual([3, 3, 2, 2, 1]);
    expect(cough.points[0].date).toBe("2026-06-01"); // oldest-first
    expect(cough.maxSeverity).toBe(3);

    // Fever curve: five readings, peak 102.4, four flagged 'high' (>99).
    expect(a.temperatures.length).toBe(5);
    expect(a.maxTempF).toBe(102.4);
    expect(a.temperatures.filter((t) => t.flag === "high").length).toBe(4);
    expect(a.temperatures[0].time).toBe("09:00"); // "HH:MM" from notes
    expect(a.latestTemp?.degF).toBe(98.9);

    // PRN meds: ibuprofen 3× with snapshotted amounts.
    expect(a.medications.length).toBe(1);
    expect(a.medications[0].name).toBe("Ibuprofen");
    expect(a.medications[0].count).toBe(3);
    expect(a.totalAdministrations).toBe(3);
    expect(a.medications[0].administrations.map((x) => x.amount)).toEqual([
      "200 mg",
      "200 mg",
      "400 mg",
    ]);

    // Notes carry the symptom note.
    expect(a.notes).toContainEqual({
      date: "2026-06-03",
      text: "Cough: loosening up",
    });

    // Headline formats over the assembly.
    expect(episodeHeadline(a)).toBe(
      "Illness · day 5 · fever trending down · 3 symptoms · ibuprofen 3×"
    );
  });

  it("excludes SCHEDULED (non-PRN) doses from the medication story", () => {
    const p = newProfile("scheduled-noise");
    seedFiveDayEpisode(p);
    // A scheduled daily supplement confirmed during the window must NOT appear.
    const supId = Number(
      db
        .prepare(
          `INSERT INTO intake_items (profile_id, name, active, kind, condition, priority, as_needed)
           VALUES (?, 'Vitamin D', 1, 'supplement', 'daily', 'low', 0)`
        )
        .run(p).lastInsertRowid
    );
    const supDose = Number(
      db
        .prepare(
          `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
           VALUES (?, '1 cap', 'morning', 'any', 0)`
        )
        .run(supId).lastInsertRowid
    );
    logAdmin(supDose, supId, "2026-06-02", "1 cap");
    const a = assembleIllnessEpisode(p, CLOSED);
    expect(a.medications.map((m) => m.name)).toEqual(["Ibuprofen"]);
  });

  it("uses the linked dose amount when a legacy administration has no snapshot", () => {
    const p = newProfile("legacy-dose-amount");
    const { itemId, doseId } = newPrnMed(p, "Ibuprofen");
    db.prepare(
      `INSERT INTO intake_item_logs
         (dose_id, item_id, date, given_at, amount, status)
       VALUES (?, ?, '2026-06-02', '2026-06-02 15:30:00', NULL, 'taken')`
    ).run(doseId, itemId);

    const a = assembleIllnessEpisode(p, CLOSED);

    expect(a.medications[0].administrations[0].amount).toBe("200 mg");
  });

  it("promote-to-condition bridges the range; undo removes only the episode-sourced row", () => {
    const p = newProfile("promote");
    seedFiveDayEpisode(p);
    const episodeId = Number(
      db
        .prepare(
          `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
           VALUES (?, 'Illness', '2026-06-01', '2026-06-06')`
        )
        .run(p).lastInsertRowid
    );
    const storedEpisode: IllnessEpisode = { id: episodeId, ...CLOSED };

    const out = promoteEpisodeToConditionCore(p, episodeId);
    expect(out.kind).toBe("promoted");
    const row = db
      .prepare(
        `SELECT name, status, onset_date, resolved_date, source, external_id
           FROM conditions WHERE profile_id = ?`
      )
      .get(p) as {
      name: string;
      status: string;
      onset_date: string;
      resolved_date: string;
      source: string;
      external_id: string;
    };
    expect(row.name).toBe("Illness");
    expect(row.status).toBe("resolved");
    expect(row.onset_date).toBe("2026-06-01");
    expect(row.resolved_date).toBe("2026-06-05"); // end-1 (last active day)
    expect(row.source).toBe("episode");
    expect(row.external_id).toBe(`illness-episode:${episodeId}`);

    // The bridged condition surfaces in the assembly, flagged fromEpisode.
    const a = assembleIllnessEpisode(p, storedEpisode);
    expect(a.conditions).toContainEqual(
      expect.objectContaining({ name: "Illness", fromEpisode: true })
    );

    // Re-promote is an idempotent no-op (still one row).
    const again = promoteEpisodeToConditionCore(p, episodeId);
    expect(again.kind).toBe("already");
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM conditions WHERE profile_id = ?")
          .get(p) as { n: number }
      ).n
    ).toBe(1);

    // Undo deletes the episode-sourced row.
    expect(unpromoteEpisodeConditionCore(p, episodeId)).toBe(true);
    expect(
      (
        db
          .prepare("SELECT COUNT(*) AS n FROM conditions WHERE profile_id = ?")
          .get(p) as { n: number }
      ).n
    ).toBe(0);
  });

  it("an ongoing episode stays active with a null resolved date when promoted", () => {
    const p = newProfile("ongoing-promote");
    const episodeId = Number(
      db
        .prepare(
          `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
           VALUES (?, 'Illness', '2026-06-01', NULL)`
        )
        .run(p).lastInsertRowid
    );
    const out = promoteEpisodeToConditionCore(p, episodeId);
    expect(out.kind).toBe("promoted");
    const row = db
      .prepare(
        `SELECT status, resolved_date FROM conditions WHERE profile_id = ?`
      )
      .get(p) as { status: string; resolved_date: string | null };
    expect(row.status).toBe("active");
    expect(row.resolved_date).toBeNull();
  });
});

// ── currentEpisodeForProfile + cross-profile household access (grants-scoped) ──

// Make `p` currently sick: Illness flagged+active, a start event, and a symptom today.
function makeCurrentlySick(p: number) {
  resolveSituationId(p, "Illness"); // born illness_type=1
  db.prepare(
    `UPDATE situations SET active = 1 WHERE profile_id = ? AND name = 'Illness'`
  ).run(p);
  const start = shiftDateStr(today(p), -2);
  const events: SituationEvent[] = [
    { date: start, situation: "Illness", change: "start" },
  ];
  setProfileSetting(
    p,
    "situation_events",
    serializeSituationEvents([], events)
  );
  // #856: the open episode is now a ROW (identity + annotations); membership stays
  // derived. Open one starting `start` so currentEpisodeForProfile resolves it.
  db.prepare(
    `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
     VALUES (?, 'Illness', ?, NULL)`
  ).run(p, start);
  logSymptomCore(p, "cough", 2, today(p));
  logTemp(p, today(p), "08:00", 101.3);
}

describe("currentEpisodeForProfile + household access", () => {
  it("returns an open assembled episode for a sick profile, null for a well one", () => {
    const sick = newProfile("sick-now");
    makeCurrentlySick(sick);
    const ep = currentEpisodeForProfile(sick);
    expect(ep).not.toBeNull();
    expect(ep!.ongoing).toBe(true);
    expect(householdSickLine("Mia", ep!)).toMatch(
      /^Mia · sick day \d+ · 101\.3 °F$/
    );

    const well = newProfile("well-now");
    expect(currentEpisodeForProfile(well)).toBeNull();
  });

  it("the household reach is grants-scoped: a member sees only granted profiles", () => {
    const sick = newProfile("household-sick");
    makeCurrentlySick(sick);
    const other = newProfile("household-other");
    // The illness hero (#858) iterates getAccessibleProfiles() (grants-scoped:
    // admins=all, members=grants) — the SAME reach the Household page uses. Assert that
    // reach over the underlying login_profiles JOIN (auth itself is mocked in this tier).
    const memberReach = (loginId: number) =>
      (
        db
          .prepare(
            `SELECT p.id FROM profiles p
               JOIN login_profiles ap ON ap.profile_id = p.id
              WHERE ap.login_id = ? ORDER BY p.id`
          )
          .all(loginId) as { id: number }[]
      ).map((r) => r.id);

    // A member login granted ONLY `other` — never reaches `sick`.
    const memberId = Number(
      db
        .prepare(
          `INSERT INTO logins (username, password_hash, role) VALUES ('member-hh', 'x', 'member')`
        )
        .run().lastInsertRowid
    );
    db.prepare(
      `INSERT INTO login_profiles (login_id, profile_id, access) VALUES (?, ?, 'write')`
    ).run(memberId, other);

    const reach = memberReach(memberId);
    expect(reach).toContain(other);
    expect(reach).not.toContain(sick); // ungranted → the sick episode is invisible

    // Regardless of reach, the per-profile read itself is grants-independent (a login
    // that CAN reach `sick` — e.g. an admin — sees its open episode from any active
    // profile).
    expect(currentEpisodeForProfile(sick)).not.toBeNull();
  });
});

// ── openEpisodeForProfile: the illness-hero ACTIVE cockpit key (#858) ──
describe("openEpisodeForProfile", () => {
  it("returns the assembled open episode even before any signal is logged (door-A)", () => {
    // Just an open illness_episodes row (situation activated), NO symptom/temp/dose —
    // the #843 "I'm feeling sick" tap. currentEpisodeForProfile stays null (no signal),
    // but openEpisodeForProfile resolves it so the hero cockpit surfaces immediately.
    const p = newProfile("just-activated");
    const start = shiftDateStr(today(p), 0);
    db.prepare(
      `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
       VALUES (?, 'Illness', ?, NULL)`
    ).run(p, start);
    expect(currentEpisodeForProfile(p)).toBeNull();
    const ep = openEpisodeForProfile(p);
    expect(ep).not.toBeNull();
    expect(ep!.ongoing).toBe(true);
    expect(ep!.distinctSymptomCount).toBe(0);
  });

  it("is null with no open episode row, and null once the episode is closed", () => {
    const well = newProfile("no-episode");
    expect(openEpisodeForProfile(well)).toBeNull();

    const closed = newProfile("closed-episode");
    db.prepare(
      `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
       VALUES (?, 'Illness', '2026-05-01', '2026-05-06')`
    ).run(closed);
    expect(openEpisodeForProfile(closed)).toBeNull();
  });
});

// ── resolveEpisodeAcrossProfiles: the #879 cross-profile read boundary ──
// The episode [id] page resolves an episode by id across the viewer's ACCESSIBLE set,
// allowing a caregiver to read a household member's episode WITHOUT switching, while an
// UNGRANTED profile's episode stays a 404. Both directions are pinned here (the page's
// grants boundary is auth; this is the store mechanism that keeps every query scoped).
describe("resolveEpisodeAcrossProfiles (#879)", () => {
  function openEpisode(p: number): number {
    return Number(
      db
        .prepare(
          `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
           VALUES (?, 'Illness', ?, NULL)`
        )
        .run(p, shiftDateStr(today(p), -1)).lastInsertRowid
    );
  }

  it("resolves a non-active but ACCESSIBLE profile's episode to its owner", () => {
    const active = newProfile("resolver-active");
    const member = newProfile("resolver-member");
    const id = openEpisode(member);

    // The viewer's accessible set contains BOTH profiles (a two-grant caregiver acting
    // as `active`); the member's episode resolves to the member, not the active profile.
    const resolved = resolveEpisodeAcrossProfiles([active, member], id);
    expect(resolved).not.toBeNull();
    expect(resolved!.profileId).toBe(member);
    expect(resolved!.row.id).toBe(id);
  });

  it("404s (null) for an episode owned by no accessible profile — the grants boundary holds", () => {
    const ungranted = newProfile("resolver-ungranted");
    const active = newProfile("resolver-active-2");
    const id = openEpisode(ungranted);

    // `ungranted` is NOT in the accessible set, so guessing its episode id resolves to
    // nothing — the same 404 the encounters precedent gives for another profile's id.
    expect(resolveEpisodeAcrossProfiles([active], id)).toBeNull();
    // But an accessible viewer of `ungranted` (e.g. an admin who reaches all) resolves it.
    expect(
      resolveEpisodeAcrossProfiles([active, ungranted], id)?.profileId
    ).toBe(ungranted);
  });
});
