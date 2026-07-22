// SERVER-ACTION TIER — episode-end medication reconciliation + dormant-PRN sweep (#880).
//
// endEpisodeWithMedsAction ends an illness episode AND closes the courses of the SELECTED
// episode-associated meds in one writeTx, with the new `illness_resolved` stop reason. It
// is suggest-only (#560): the action re-derives the associated set and intersects the
// posted ids with it, so a forged/unrelated med can never be closed, and declining leaves
// everything untouched. The dormant-PRN sweep's dismiss/restore ride the #203 id-keyed
// findings bus. Auth is mocked (harness); the DB is real.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  endEpisodeWithMedsAction,
  reopenEpisodeAction,
} from "@/app/(app)/medical/episodes/actions";
import { restartMedication } from "@/app/(app)/medications/actions";
import {
  dismissDormantPrn,
  restoreDormantPrn,
} from "@/app/(app)/medications/actions";
import { dormantPrnDismissalKey } from "@/lib/dormant-prn";
import { logSymptomCore } from "@/lib/symptom-log-write";
import { resolveSituationId } from "@/lib/settings";
import { getOpenEpisodeRow } from "@/lib/illness-episode-store";
import { shiftDateStr } from "@/lib/date";
import { seedActor, fd } from "./harness";

// Make the acting profile currently sick with an ongoing Illness episode ROW starting
// `daysAgo` days back; return its id.
function makeSick(profileId: number, daysAgo = 2): number {
  resolveSituationId(profileId, "Illness");
  db.prepare(
    `UPDATE situations SET active = 1 WHERE profile_id = ? AND name = 'Illness'`
  ).run(profileId);
  db.prepare(
    `INSERT INTO illness_episodes (profile_id, situation, started_at, ended_at)
     VALUES (?, 'Illness', ?, NULL)`
  ).run(profileId, shiftDateStr(today(profileId), -daysAgo));
  logSymptomCore(profileId, "cough", 2, today(profileId));
  return getOpenEpisodeRow(profileId, "Illness")!.id;
}

// An OTC (rx=0) PRN medication owned by `profileId`, with an OPEN course. `createdOn`
// controls the intake_items.created_at date (defaults to today — created during the
// episode). Returns the item id.
function seedOtcPrnMed(
  profileId: number,
  name: string,
  opts: { rx?: 0 | 1; asNeeded?: 0 | 1; createdOn?: string } = {}
): number {
  const created = opts.createdOn ?? today(profileId);
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, as_needed, rx,
            quantity_on_hand, qty_per_dose, created_at)
         VALUES (?, ?, 1, 'medication', 'daily', 'high', ?, ?, 10, 1, ?)`
      )
      .run(
        profileId,
        name,
        opts.asNeeded ?? 1,
        opts.rx ?? 0,
        `${created} 12:00:00`
      ).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '400 mg', 'any', 'any', 0)`
  ).run(itemId);
  db.prepare(
    `INSERT INTO medication_courses (item_id, started_on, stopped_on)
     VALUES (?, ?, NULL)`
  ).run(itemId, created);
  return itemId;
}

function medState(itemId: number) {
  const item = db
    .prepare("SELECT active FROM intake_items WHERE id = ?")
    .get(itemId) as { active: number };
  const course = db
    .prepare(
      "SELECT stopped_on, stop_reason FROM medication_courses WHERE item_id = ? ORDER BY id DESC LIMIT 1"
    )
    .get(itemId) as { stopped_on: string | null; stop_reason: string | null };
  return { active: item.active, ...course };
}

function dismissalKeys(profileId: number): string[] {
  return (
    db
      .prepare(
        "SELECT signal_key FROM upcoming_dismissals WHERE profile_id = ? ORDER BY signal_key"
      )
      .all(profileId) as { signal_key: string }[]
  ).map((r) => r.signal_key);
}

describe("endEpisodeWithMedsAction — confirm closes selected courses (#880)", () => {
  it("ends the episode and closes the selected OTC/PRN course with illness_resolved", async () => {
    const { profile } = seedActor();
    const episodeId = makeSick(profile.id);
    const ibuprofen = seedOtcPrnMed(profile.id, "Ibuprofen");

    const res = await endEpisodeWithMedsAction(
      fd({ episodeId, medItemIds: String(ibuprofen) })
    );
    expect(res.ok).toBe(true);
    // Episode closed…
    expect(getOpenEpisodeRow(profile.id, "Illness")).toBeNull();
    // …and the med course closed with the new reason + active cleared.
    const s = medState(ibuprofen);
    expect(s.active).toBe(0);
    expect(s.stopped_on).not.toBeNull();
    expect(s.stop_reason).toBe("illness_resolved");
  });

  it("declining (no meds selected) ends the episode but leaves meds untouched", async () => {
    const { profile } = seedActor();
    const episodeId = makeSick(profile.id);
    const ibuprofen = seedOtcPrnMed(profile.id, "Ibuprofen");

    const res = await endEpisodeWithMedsAction(fd({ episodeId }));
    expect(res.ok).toBe(true);
    expect(getOpenEpisodeRow(profile.id, "Illness")).toBeNull();
    const s = medState(ibuprofen);
    expect(s.active).toBe(1);
    expect(s.stopped_on).toBeNull();
  });

  it("suggest-only: a NON-associated (unrelated) med id is ignored, never closed", async () => {
    const { profile } = seedActor();
    const episodeId = makeSick(profile.id);
    // Created long before the episode + no in-range use → NOT associated.
    const chronic = seedOtcPrnMed(profile.id, "Chronic Med", {
      createdOn: shiftDateStr(today(profile.id), -400),
    });

    const res = await endEpisodeWithMedsAction(
      fd({ episodeId, medItemIds: String(chronic) })
    );
    expect(res.ok).toBe(true);
    // The unrelated chronic med survives (the intersection dropped it).
    const s = medState(chronic);
    expect(s.active).toBe(1);
    expect(s.stopped_on).toBeNull();
  });

  it("does NOT default-close an Rx course even when it is submitted... only listed ones", async () => {
    // An Rx med created during the episode IS associated (listed), so a deliberate submit
    // still closes it — the intersection allows listed meds; the DEFAULT-unchecked posture
    // lives in the pure classifier + the UI. Here we assert the association gate itself.
    const { profile } = seedActor();
    const episodeId = makeSick(profile.id);
    const amox = seedOtcPrnMed(profile.id, "Amoxicillin", {
      rx: 1,
      asNeeded: 0,
    });
    const res = await endEpisodeWithMedsAction(
      fd({ episodeId, medItemIds: String(amox) })
    );
    expect(res.ok).toBe(true);
    expect(medState(amox).stop_reason).toBe("illness_resolved");
  });
});

// #1140 Part B — reopen restores the meds the episode's end stopped (the symmetric
// inverse of end-with-meds). The end persists the stopped set; reopen restarts the
// selected, still-eligible ones (suggest-only), guarded against an intervening manual
// decision, and consumes the link.
describe("reopenEpisodeAction restarts the meds the end stopped (#1140 Part B)", () => {
  function stoppedMedRows(profileId: number, episodeId: number): number {
    return (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM episode_stopped_meds WHERE profile_id = ? AND episode_id = ?"
        )
        .get(profileId, episodeId) as { n: number }
    ).n;
  }

  it("end-with-meds persists the stopped set; reopen restarts the selected one and consumes the link", async () => {
    const { profile } = seedActor();
    const episodeId = makeSick(profile.id);
    const ibuprofen = seedOtcPrnMed(profile.id, "Ibuprofen");

    await endEpisodeWithMedsAction(
      fd({ episodeId, medItemIds: String(ibuprofen) })
    );
    expect(medState(ibuprofen).active).toBe(0);
    expect(stoppedMedRows(profile.id, episodeId)).toBe(1);

    const res = await reopenEpisodeAction(
      fd({ episodeId, medItemIds: String(ibuprofen) })
    );
    expect(res.ok).toBe(true);
    // The med is active again with a fresh open course…
    const s = medState(ibuprofen);
    expect(s.active).toBe(1);
    expect(s.stopped_on).toBeNull();
    // …and the reversal record was consumed.
    expect(stoppedMedRows(profile.id, episodeId)).toBe(0);
  });

  it("suggest-only: an empty selection reopens the illness and restarts nothing", async () => {
    const { profile } = seedActor();
    const episodeId = makeSick(profile.id);
    const ibuprofen = seedOtcPrnMed(profile.id, "Ibuprofen");
    await endEpisodeWithMedsAction(
      fd({ episodeId, medItemIds: String(ibuprofen) })
    );

    const res = await reopenEpisodeAction(fd({ episodeId })); // no medItemIds
    expect(res.ok).toBe(true);
    expect(getOpenEpisodeRow(profile.id, "Illness")).not.toBeNull(); // reopened
    expect(medState(ibuprofen).active).toBe(0); // still Past — nothing restarted
    // The link survives for a later decision.
    expect(stoppedMedRows(profile.id, episodeId)).toBe(1);
  });

  it("skips a med the user manually restarted between end and reopen (#202 guard)", async () => {
    const { profile } = seedActor();
    const episodeId = makeSick(profile.id);
    const ibuprofen = seedOtcPrnMed(profile.id, "Ibuprofen");
    await endEpisodeWithMedsAction(
      fd({ episodeId, medItemIds: String(ibuprofen) })
    );
    // The user manually restarts it — its latest course is no longer the illness_resolved
    // close, so a reopen auto-restart must skip it and not double-open a course.
    await restartMedication(fd({ id: ibuprofen }));
    const coursesBefore = (
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM medication_courses WHERE item_id = ?"
        )
        .get(ibuprofen) as { n: number }
    ).n;

    const res = await reopenEpisodeAction(
      fd({ episodeId, medItemIds: String(ibuprofen) })
    );
    expect(res.ok).toBe(true);
    // No extra course minted; the med stays as the manual restart left it (active).
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM medication_courses WHERE item_id = ?"
          )
          .get(ibuprofen) as { n: number }
      ).n
    ).toBe(coursesBefore);
    expect(medState(ibuprofen).active).toBe(1);
  });
});

describe("dormant-PRN sweep dismiss/restore (#880 item 3)", () => {
  it("stores and clears the id-keyed dormant-prn dismissal", async () => {
    const { profile } = seedActor();
    const key = dormantPrnDismissalKey(77);
    expect((await dismissDormantPrn(fd({ dedupe_key: key }))).ok).toBe(true);
    expect(dismissalKeys(profile.id)).toContain("dormant-prn:77");

    expect((await restoreDormantPrn(fd({ dedupe_key: key }))).ok).toBe(true);
    expect(dismissalKeys(profile.id)).not.toContain("dormant-prn:77");
  });

  it("refuses a key outside the dormant-prn namespace", async () => {
    const { profile } = seedActor();
    const res = await dismissDormantPrn(fd({ dedupe_key: "med-bridge:x" }));
    expect(res.ok).toBe(false);
    expect(dismissalKeys(profile.id)).toEqual([]);
  });
});
