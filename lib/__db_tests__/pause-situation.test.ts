// DB INTEGRATION TIER (#1296 pause-during-situation + #1299 surgery bridge).
//
// End-to-end over the real schema (migration 108 pause_situation_id): a scheduled item
// with an active pause situation is ABSENT from the merged due set (collectUpcoming) and
// the digest dose count, PRESENT with held-badge data (getSupplements pause_situation +
// heldItemsBy), and RESTORED to dueness the same day the situation deactivates. Plus the
// #1299 producer: a seeded surgical visit yields the suggestion inside the lead window,
// not before, and the passed-date clear/Post-op suggestion after.
//
// Deterministic: :memory:-backed temp DB via setup.ts; no network.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import {
  getSupplements,
  collectUpcoming,
  getSurgeryBridgeSuggestions,
} from "@/lib/queries";
import { setActiveSituations, resolveSituationId } from "@/lib/settings";
import { gatherDigestInput } from "@/lib/notifications/digest-data";
import { buildDigest, renderDigestMessage } from "@/lib/notifications/digest";
import { heldItemsBy } from "@/lib/supplement-schedule";
import { shiftDateStr } from "@/lib/date";

function newProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

// A daily supplement + one scheduled dose. Optionally paused during `pauseSituation`.
function seedDailyDose(
  profileId: number,
  name: string,
  pauseSituation?: string
): number {
  const pauseId = pauseSituation
    ? resolveSituationId(profileId, pauseSituation)
    : null;
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, active, kind, condition, priority, qty_per_dose, pause_situation_id)
         VALUES (?, ?, 1, 'supplement', 'daily', 'high', 1, ?)`
      )
      .run(profileId, name, pauseId).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 cap', 'morning', 'any', 0)`
  ).run(itemId);
  return itemId;
}

const doseKeys = (profileId: number, td: string) =>
  collectUpcoming(profileId, td)
    .filter((i) => i.domain === "dose")
    .map((i) => i.key);

describe("pause-during-situation dueness (#1296)", () => {
  it("holds a paused item off the due set + digest, restores it on deactivation", () => {
    const p = newProfile("held");
    const td = today(p);
    seedDailyDose(p, "Fish Oil", "Pre-surgery");

    // Pre-surgery inactive → the dose is due (present in collectUpcoming, counted).
    expect(doseKeys(p, td).length).toBe(1);
    expect(gatherDigestInput(p, "Held").doseCount).toBe(1);

    // Activate Pre-surgery → held: absent from the due set AND the digest count.
    setActiveSituations(p, ["Pre-surgery"]);
    expect(doseKeys(p, td).length).toBe(0);
    const inputHeld = gatherDigestInput(p, "Held");
    expect(inputHeld.doseCount).toBe(0);
    // …but visible: held-badge data on the row + the digest hold line.
    const supps = getSupplements(p);
    expect(
      heldItemsBy(supps, new Set(["Pre-surgery"])).map((h) => h.item.name)
    ).toEqual(["Fish Oil"]);
    expect(inputHeld.heldCount).toBe(1);
    expect(inputHeld.heldSituation).toBe("Pre-surgery");
    const model = buildDigest(inputHeld);
    expect(model).not.toBeNull();
    expect(renderDigestMessage(model!).body).toContain(
      "1 item held by Pre-surgery"
    );

    // Deactivate → same-day resume.
    setActiveSituations(p, []);
    expect(doseKeys(p, td).length).toBe(1);
    expect(gatherDigestInput(p, "Held").doseCount).toBe(1);
  });

  it("held beats an on-during link when both situations are active", () => {
    const p = newProfile("both");
    const td = today(p);
    const illnessId = resolveSituationId(p, "Illness")!;
    const preId = resolveSituationId(p, "Pre-surgery")!;
    const itemId = Number(
      db
        .prepare(
          `INSERT INTO intake_items
             (profile_id, name, active, kind, condition, priority, qty_per_dose,
              situation_id, pause_situation_id)
           VALUES (?, 'Zinc', 1, 'supplement', 'situational', 'high', 1, ?, ?)`
        )
        .run(p, illnessId, preId).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
       VALUES (?, '1 cap', 'morning', 'any', 0)`
    ).run(itemId);

    // Illness only → due.
    setActiveSituations(p, ["Illness"]);
    expect(doseKeys(p, td).length).toBe(1);
    // Illness + Pre-surgery → held wins.
    setActiveSituations(p, ["Illness", "Pre-surgery"]);
    expect(doseKeys(p, td).length).toBe(0);
  });
});

describe("surgery bridge producer (#1299)", () => {
  function seedVisit(
    profileId: number,
    title: string,
    dateOffset: number
  ): number {
    const date = shiftDateStr(today(profileId), dateOffset);
    return Number(
      db
        .prepare(
          `INSERT INTO appointments (profile_id, scheduled_at, title, status)
           VALUES (?, ?, ?, 'scheduled')`
        )
        .run(profileId, `${date} 09:00`, title).lastInsertRowid
    );
  }

  it("suggests Pre-surgery inside the lead window, not before", () => {
    const p = newProfile("surgery");
    // 20 days out → outside default 7-day lead → no suggestion.
    const far = seedVisit(p, "Arthroscopy", 20);
    expect(getSurgeryBridgeSuggestions(p)).toEqual([]);

    // Move it to 5 days out → inside the window.
    db.prepare(`UPDATE appointments SET scheduled_at = ? WHERE id = ?`).run(
      `${shiftDateStr(today(p), 5)} 09:00`,
      far
    );
    const cards = getSurgeryBridgeSuggestions(p);
    expect(cards.length).toBe(1);
    expect(cards[0].suggestion.phase).toBe("pre");
    expect(cards[0].activateSituation).toBe("Pre-surgery");
  });

  it("carries the actual held-count and offers the Post-op transition after the date", () => {
    const p = newProfile("surgery-held");
    // A supplement paused during Pre-surgery → the held-count the chip copy reads.
    seedDailyDose(p, "Vitamin E", "Pre-surgery");
    const visit = seedVisit(p, "Appendectomy", 3);

    const pre = getSurgeryBridgeSuggestions(p);
    expect(pre[0].suggestion.phase).toBe("pre");
    expect(pre[0].heldCount).toBe(1);

    // Date passes + Pre-surgery active → the post transition (clear + Post-op) appears.
    db.prepare(`UPDATE appointments SET scheduled_at = ? WHERE id = ?`).run(
      `${shiftDateStr(today(p), -1)} 09:00`,
      visit
    );
    setActiveSituations(p, ["Pre-surgery"]);
    const post = getSurgeryBridgeSuggestions(p);
    expect(post[0].suggestion.phase).toBe("post");
    expect(post[0].suggestion.presurgeryActive).toBe(true);
    expect(post[0].activateSituation).toBe("Post-op");
  });

  it("a non-surgical visit yields nothing", () => {
    const p = newProfile("dental");
    seedVisit(p, "Dental cleaning", 3);
    expect(getSurgeryBridgeSuggestions(p)).toEqual([]);
  });
});
