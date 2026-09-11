// DB INTEGRATION TIER — the record reads a composed act off the rows a real tap wrote
// (#5618 ruling 5).
//
// WHY THIS TIER. The collapse rule is pure and driven at the unit tier; what a bundle
// row RENDERS is driven at the component tier. What neither can reach is the half in
// between: whether the facts the record reads out of `food_log_events` and
// `intake_item_logs` actually describe the act the shipped writer wrote. So the fixture
// here goes through `logUsualRoutineCore` rather than INSERTing a bundle id — a test
// that seeded the id would prove the reader against a shape only it produces.
//
// The null half is load-bearing too, and for the reason `act-bundle-id.test.ts` gives:
// a reader that returned a fact for every row would destroy the reading the whole model
// depends on, where a row with NO bundle means "stated on its own". Every row written
// before 2026-09-04 is that row, and this is where the record's version of that is
// pinned against a writer or a reader that starts inventing one.
//
// Fixtures are synthetic throwaway rows (per-file temp DB via setup.ts). No PHI.

import { describe, expect, it } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import { logUsualRoutineCore } from "@/lib/usual-routine-write";
import { gatherHistoryLog, historyDayBundleFacts } from "@/lib/history";
import { groupHistoryBundles, isHistoryBundle } from "@/lib/history-bundle";

function login(): number {
  return Number(
    db
      .prepare("INSERT INTO logins (username, password_hash) VALUES (?, 'x')")
      .run(`bundle_${Math.random().toString(36).slice(2, 8)}`).lastInsertRowid
  );
}

// A prior day's serving in both stores the usual offer reads, so the habit stands
// without going through the writer under test.
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

function seedDose(
  profileId: number,
  name: string,
  stack: string | null
): number {
  const createdAt = `${shiftDateStr(today(profileId), -20)} 00:00:00`;
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items (profile_id, name, kind, stack, active, obligation, condition, created_at)
         VALUES (?, ?, 'supplement', ?, 1, 'should', 'daily', ?)`
      )
      .run(profileId, name, stack, createdAt).lastInsertRowid
  );
  return Number(
    db
      .prepare(
        `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort, created_at)
         VALUES (?, '1 scoop', 'morning', 'any', 0, ?)`
      )
      .run(itemId, createdAt).lastInsertRowid
  );
}

/**
 * Twelve mornings of fermented + berries and two Morning-declared doses.
 *
 * The habit days start TWO back, leaving the day every case taps on empty: seeded on
 * the tap day itself, the writer finds those groups already logged and writes only the
 * dose half, which is a different fixture answering a different question.
 */
function seedMorning(tag: string) {
  const profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(tag)
      .lastInsertRowid
  );
  setTimezone(profileId, "UTC");
  const anchor = today(profileId);
  for (let d = 2; d <= 13; d++) {
    const date = shiftDateStr(anchor, -d);
    priorTap(profileId, "fermented", date, "08:00:00");
    priorTap(profileId, "berries", date, "08:05:00");
  }
  return {
    profileId,
    anchor,
    creatine: seedDose(profileId, `${tag} Creatine`, "Morning Smoothie"),
    collagen: seedDose(profileId, `${tag} Collagen`, "Morning Smoothie"),
  };
}

function entriesFor(profileId: number, loginId: number, day: string) {
  const gather = gatherHistoryLog(profileId, {
    loginId,
    day,
    limit: 50,
    presentKinds: false,
  });
  return {
    gather,
    entries: groupHistoryBundles(gather.rows, gather.bundleFacts),
  };
}

describe("a usual tap on a past day is one row on the record", () => {
  it("reads one act off the rows the writer wrote, named for the offer", () => {
    const loginId = login();
    const { profileId, anchor, creatine, collagen } = seedMorning("record-act");
    const day = shiftDateStr(anchor, -1);
    const outcome = logUsualRoutineCore(
      profileId,
      "Morning",
      day,
      ["fermented", "berries"],
      [creatine, collagen],
      "page"
    );
    expect(outcome.kind).toBe("logged");

    // THE READER'S OWN ANSWER FIRST: every row the tap wrote records ONE id, and it is
    // one id rather than four — "they were one act" is a claim about the set.
    const facts = historyDayBundleFacts(profileId, day);
    expect(facts.size).toBe(4);
    expect(new Set([...facts.values()].map((f) => f.bundleId)).size).toBe(1);
    // The naming inputs are the ones the write recorded, not ones derived back out of a
    // filing minute: the window the offer declared, and the stack the item carries.
    expect(
      [...facts.values()].filter((f) => f.window === "Morning")
    ).toHaveLength(2);
    expect(
      [...facts.values()].filter((f) => f.stack === "Morning Smoothie")
    ).toHaveLength(2);

    const { entries } = entriesFor(profileId, loginId, day);
    const acts = entries.filter(isHistoryBundle);
    expect(acts).toHaveLength(1);
    expect(acts[0]!.title).toBe("Your usual Morning");
    expect(acts[0]!.detail).toBe("2 servings · 2 doses");
    expect(acts[0]!.members).toHaveLength(4);
    // The day is ONE row on the record where it was four.
    expect(entries).toHaveLength(1);
    // And the two id spaces the batch correction cores take are the ones the row will
    // hand them — every member reachable, none invented.
    expect(acts[0]!.servingIds).toHaveLength(2);
    expect(acts[0]!.doseLogIds).toHaveLength(2);
  });

  // THE FEED PAYS NOTHING FOR AN ANSWER IT DOES NOT DRAW, the same bound `dayEvents`
  // carries. Composition is a question about one day's rows side by side.
  it("asks nothing about composition on a read with no day", () => {
    const loginId = login();
    const { profileId, anchor, creatine, collagen } =
      seedMorning("record-feed");
    const day = shiftDateStr(anchor, -1);
    logUsualRoutineCore(
      profileId,
      "Morning",
      day,
      ["fermented", "berries"],
      [creatine, collagen],
      "page"
    );
    const gather = gatherHistoryLog(profileId, {
      loginId,
      limit: 50,
      presentKinds: false,
    });
    expect(gather.bundleFacts.size).toBe(0);
    expect(
      groupHistoryBundles(gather.rows, gather.bundleFacts).filter(
        isHistoryBundle
      )
    ).toEqual([]);
  });
});

describe("rows written before 2026-09-04 carry no id and stay flat", () => {
  it("returns no fact for rows nothing composed, and the day renders one row per row", () => {
    const loginId = login();
    const { profileId, anchor } = seedMorning("record-flat");
    const day = shiftDateStr(anchor, -1);
    // The rows an old day actually holds: written one at a time, `bundle_id` NULL —
    // which is what the column's deliberate lack of a backfill leaves behind.
    priorTap(profileId, "nuts_seeds", day, "07:41:00");
    priorTap(profileId, "leafy_greens", day, "07:42:00");
    priorTap(profileId, "cruciferous", day, "07:43:00");
    expect(
      db
        .prepare(
          `SELECT COUNT(*) AS n FROM food_log_events
            WHERE profile_id = ? AND date = ? AND bundle_id IS NOT NULL`
        )
        .get(profileId, day)
    ).toEqual({ n: 0 });

    expect(historyDayBundleFacts(profileId, day).size).toBe(0);
    const { gather, entries } = entriesFor(profileId, loginId, day);
    expect(gather.rows).toHaveLength(3);
    expect(entries.filter(isHistoryBundle)).toEqual([]);
    // ONE ROW PER ROW. A grouping keyed on the absent id would have folded three
    // unrelated servings into a single row stating one time for all of them.
    expect(entries).toHaveLength(3);
    expect(entries).toEqual(gather.rows);
  });

  it("collapses only the composed rows on a day that holds both", () => {
    const loginId = login();
    const { profileId, anchor, creatine, collagen } =
      seedMorning("record-mixed");
    const day = shiftDateStr(anchor, -1);
    logUsualRoutineCore(
      profileId,
      "Morning",
      day,
      ["fermented", "berries"],
      [creatine, collagen],
      "page"
    );
    priorTap(profileId, "nuts_seeds", day, "12:15:00");

    const { entries } = entriesFor(profileId, loginId, day);
    expect(entries).toHaveLength(2);
    expect(entries.filter(isHistoryBundle)).toHaveLength(1);
    expect(
      entries.filter((entry) => !isHistoryBundle(entry)).map((r) => r.id)
    ).toHaveLength(1);
  });
});
