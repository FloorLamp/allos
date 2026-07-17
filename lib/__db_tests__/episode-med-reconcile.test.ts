// DB INTEGRATION TIER (issue #880, the builders-get-DB-tier-tests rule #448).
//
// getEpisodeMedReconciliation GATHERS DB state (each active med's identity, created date,
// and administration dates) and hands it to the pure episodeMedChecklist, so it carries a
// DB-tier fixture asserting the END-TO-END suggestion output — the pure tier can't see the
// SQL gather. The full arc is then exercised: end the episode → accept → the ibuprofen
// leaves Current (active cleared, course closed with illness_resolved) so the interaction
// stack / emergency card stop counting it; restart revives it.
//
// Deterministic: :memory:-backed temp DB via setup.ts; fixed relative dates; no network.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  getEpisodeMedReconciliation,
  getMedicationCourses,
  restartMedicationCourse,
} from "@/lib/queries";
import { endEpisodeWithMedReconciliation } from "@/lib/illness-episode-write";
import { loadMedicationsData } from "@/app/(app)/medications/med-data";
import { resolveSituationId } from "@/lib/settings";
import { getOpenEpisodeRow } from "@/lib/illness-episode-store";
import { logSymptomCore } from "@/lib/symptom-log-write";
import { shiftDateStr } from "@/lib/date";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function makeSick(profileId: number, daysAgo = 3): number {
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

// A medication with an OPEN course + a dose row; optional 'taken' administration.
function seedMed(
  profileId: number,
  name: string,
  opts: {
    rx?: 0 | 1;
    asNeeded?: 0 | 1;
    createdOn?: string;
    administeredOn?: string | null;
  } = {}
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
  const doseId = Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '400 mg', 'any', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO medication_courses (item_id, started_on, stopped_on) VALUES (?, ?, NULL)`
  ).run(itemId, created);
  if (opts.administeredOn) {
    db.prepare(
      `INSERT INTO intake_item_logs (dose_id, item_id, date, status, given_at)
       VALUES (?, ?, ?, 'taken', ?)`
    ).run(
      doseId,
      itemId,
      opts.administeredOn,
      `${opts.administeredOn} 12:00:00`
    );
  }
  return itemId;
}

describe("getEpisodeMedReconciliation gather (#448)", () => {
  it("lists the OTC/PRN created during (checked), the Rx (unchecked), and drops the unrelated", () => {
    const p = newProfile("recon-gather");
    const episodeId = makeSick(p);
    const ibuprofen = seedMed(p, "Ibuprofen", {
      administeredOn: shiftDateStr(today(p), -1),
    });
    const amox = seedMed(p, "Amoxicillin", { rx: 1, asNeeded: 0 });
    // A chronic PRN created long before with no in-range use → not associated.
    seedMed(p, "Chronic Allergy Med", {
      createdOn: shiftDateStr(today(p), -400),
      administeredOn: shiftDateStr(today(p), -300),
    });

    const list = getEpisodeMedReconciliation(p, episodeId);
    const byId = new Map(list.map((s) => [s.itemId, s]));
    expect(byId.get(ibuprofen)).toMatchObject({
      klass: "otc-prn",
      defaultChecked: true,
    });
    expect(byId.get(amox)).toMatchObject({
      klass: "course",
      defaultChecked: false,
    });
    expect(list).toHaveLength(2); // chronic med dropped
  });

  it("returns [] for a missing episode", () => {
    const p = newProfile("recon-missing");
    expect(getEpisodeMedReconciliation(p, 999999)).toEqual([]);
  });
});

describe("episode-end → accept → med leaves Current; restart revives (#880)", () => {
  it("closes the accepted course; the med leaves Current + the active stack; restart brings it back", () => {
    const p = newProfile("recon-arc");
    const episodeId = makeSick(p);
    const ibuprofen = seedMed(p, "Ibuprofen", {
      administeredOn: shiftDateStr(today(p), -1),
    });

    // Before: ibuprofen is a current, active med in the interaction stack.
    const before = loadMedicationsData(p);
    expect(before.current.some((m) => m.med.id === ibuprofen)).toBe(true);
    expect(before.stackItems.find((s) => s.id === ibuprofen)?.active).toBe(
      true
    );

    // Accept the suggestion: end the episode AND close the ibuprofen course.
    const outcome = endEpisodeWithMedReconciliation(p, episodeId, [ibuprofen]);
    expect(outcome.kind).toBe("ended");
    expect(outcome.stoppedItemIds).toEqual([ibuprofen]);
    expect(getOpenEpisodeRow(p, "Illness")).toBeNull();

    // After: the course is closed with illness_resolved, and the med has left Current +
    // the active stack (so interaction/UL checks + the emergency card stop counting it).
    const courses = getMedicationCourses(p).filter(
      (c) => c.item_id === ibuprofen
    );
    expect(courses.every((c) => c.stopped_on != null)).toBe(true);
    expect(courses.some((c) => c.stop_reason === "illness_resolved")).toBe(
      true
    );

    const after = loadMedicationsData(p);
    expect(after.current.some((m) => m.med.id === ibuprofen)).toBe(false);
    expect(after.past.some((m) => m.med.id === ibuprofen)).toBe(true);
    expect(after.stackItems.find((s) => s.id === ibuprofen)?.active).toBe(
      false
    );

    // Restart (the next illness): a NEW open course, active again → back in Current.
    restartMedicationCourse(p, ibuprofen, today(p));
    const revived = loadMedicationsData(p);
    expect(revived.current.some((m) => m.med.id === ibuprofen)).toBe(true);
    expect(revived.stackItems.find((s) => s.id === ibuprofen)?.active).toBe(
      true
    );
  });
});
