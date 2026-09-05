// DB INTEGRATION TIER — one act id across every table a composed write touches (#5082).
//
// The pair below is the whole criterion, and BOTH halves are load-bearing. A test that
// only asserted the stamp would pass against a writer that stamps everything — and a
// writer that stamps everything destroys the reading the Day ledger depends on, where a
// row with NO bundle means "stated on its own" (lib/day-ledger.ts). So the null case is
// not a completeness nicety; it is the other half of the same claim.
//
// The stamped assertion counts DISTINCT ids across the tap's rows rather than checking
// that each row has some id: "they were one act" is a statement about the SET, and four
// rows each carrying their own fresh bundle would satisfy the per-row form.
//
// Fixtures are synthetic throwaway rows (per-file temp DB via setup.ts). No PHI.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { logFoodServingCore } from "@/lib/food-log-write";
import { logUsualRoutineCore } from "@/lib/usual-routine-write";
import { markDoseTaken } from "@/lib/queries/intake/adherence";

// A prior day's serving, seeded straight into the two stores the offer reads, so the
// habit exists without going through the writer under test.
function priorTap(profileId: number, group: string, date: string, at: string) {
  db.prepare(
    `INSERT INTO food_daily_totals (profile_id, date, group_key, servings) VALUES (?, ?, ?, 1)
       ON CONFLICT(profile_id, date, group_key) DO UPDATE SET servings = servings + 1`
  ).run(profileId, date, group);
  db.prepare(
    `INSERT INTO food_log_events (profile_id, group_key, date, recorded_at)
     VALUES (?, ?, ?, ?)`
  ).run(profileId, group, date, `${date}T${at}Z`);
}

function seedDose(profileId: number, name: string): number {
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, active, obligation, condition)
         VALUES (?, ?, 'supplement', 1, 'should', 'daily')`
      )
      .run(profileId, name).lastInsertRowid
  );
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
         VALUES (?, '1 scoop', 'morning', 'any', 0)`
      )
      .run(itemId).lastInsertRowid
  );
}

// Twelve mornings of fermented + berries, two Morning-declared doses, today empty — the
// #2458 ledger shape in miniature, UTC so the profile's local day IS the frozen one.
function seedMorning(tag: string) {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(tag)
      .lastInsertRowid
  );
  setTimezone(profileId, "UTC");
  const anchor = today(profileId);
  for (let d = 1; d <= 12; d++) {
    const date = shiftDateStr(anchor, -d);
    priorTap(profileId, "fermented", date, "08:00:00");
    priorTap(profileId, "berries", date, "08:05:00");
  }
  return {
    profileId,
    anchor,
    creatine: seedDose(profileId, `${tag} Creatine`),
    collagen: seedDose(profileId, `${tag} Collagen`),
  };
}

// Every bundle id the day's rows carry, one row per table so a half that wrote nothing
// is visible as a zero rather than hidden inside a distinct-count of one.
function bundlesOn(profileId: number, date: string) {
  const food = db
    .prepare(
      `SELECT bundle_id FROM food_log_events WHERE profile_id = ? AND date = ?`
    )
    .all(profileId, date) as { bundle_id: string | null }[];
  const doses = db
    .prepare(
      `SELECT l.bundle_id FROM intake_item_logs l
         JOIN intake_item_doses d ON d.id = l.dose_id
         JOIN intake_items s ON s.id = d.item_id
        WHERE s.profile_id = ? AND l.date = ?`
    )
    .all(profileId, date) as { bundle_id: string | null }[];
  return {
    food: food.map((r) => r.bundle_id),
    doses: doses.map((r) => r.bundle_id),
  };
}

describe("one usual tap, one act id (#5082)", () => {
  it("stamps the same bundle on its food rows and its dose rows", () => {
    const { profileId, anchor, creatine, collagen } = seedMorning("act-stamp");

    const outcome = logUsualRoutineCore(
      profileId,
      "Morning",
      anchor,
      ["berries", "fermented"],
      [creatine, collagen],
      "page"
    );
    expect(outcome.kind).toBe("logged");

    const { food, doses } = bundlesOn(profileId, anchor);
    // BOTH HALVES ACTUALLY WROTE. Without this the distinct-count below would be
    // satisfied by a tap that logged doses and no servings at all — the exact shape
    // this issue exists to fix, passing its own test.
    expect([food.length, doses.length]).toEqual([2, 2]);
    const ids = new Set([...food, ...doses]);
    expect(ids.size).toBe(1);
    // Sixteen hex characters, because that is what `newBundle` mints (lib/bundle.ts)
    // and what the ledger's collapse key relies on being true of every bundle.
    expect([...ids][0]).toMatch(/^[0-9a-f]{16}$/);
  });

  // A single write composed nothing, so it records nothing — which is what keeps
  // "no bundle" readable as "stated on its own" rather than as "written before the
  // column existed".
  it("writes NULL for a single serving add and a single dose confirm", () => {
    const { profileId, anchor, creatine } = seedMorning("act-null");

    expect(logFoodServingCore(profileId, "berries", anchor, "page").kind).toBe(
      "logged"
    );
    expect(markDoseTaken(profileId, creatine, null, anchor, "page")).toBe(
      "logged"
    );

    expect(bundlesOn(profileId, anchor)).toEqual({
      food: [null],
      doses: [null],
    });
  });
});
