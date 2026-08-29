// DB INTEGRATION TIER — a PAST-DAY reminder's dueness is resolved against the situations
// active ON THAT DAY (#3973), through the real gather rather than the pure resolver.
//
// The thread under test is `collectWindowDoses → gatherWindowDoses → doseDueOn`, reached
// with a date that is not today — which is what a stale Telegram keyboard rebuilding
// yesterday's message (lib/notifications/telegram-callbacks.ts) and the button-liveness
// reconcile (lib/notifications/reconcile.ts) both do. It used to score that day against
// whichever situations were declared RIGHT NOW, beside a `situationsOn` resolver in the
// same function that already dated the adherence strip.
//
// The TODAY branch keeps the derived widening (#1292/#1298) and is pinned here too: it is
// a statement about now with no dated form, so it must reach today and only today.
//
// Runs via `npm run test:db` (vitest.db.config.ts).

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import {
  setTimezone,
  setActiveSituations,
  setProfileSetting,
} from "@/lib/settings";
import { resolveSituationId } from "@/lib/settings/profile-attrs";
import {
  diffSituations,
  serializeSituationEvents,
} from "@/lib/trend-annotations";
import {
  upsertMetricSamples,
  type NormMetricSample,
} from "@/lib/integrations/normalize";
import { collectWindowDoses } from "@/lib/notifications/intake";

let seq = 0;
function newProfile(): number {
  const id = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES (?)")
      .run(`Past Day Situations ${seq++}`).lastInsertRowid
  );
  setTimezone(id, "UTC");
  return id;
}

// A MEDICATION with one Morning dose, either due ON `situation` (`situational`) or a
// plain daily one HELD BY it (#1296's pause hold — the other consumer of the same
// active-situation set). A medication so the #1156 obligation floor can never be what
// decides membership, and `must` so nothing short-circuits ahead of the condition gate.
function seedItem(
  profileId: number,
  name: string,
  situation: string,
  how: "due-on" | "paused-by"
): void {
  const sid = resolveSituationId(profileId, situation)!;
  const on = how === "due-on";
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, kind, condition, obligation, active,
            situation, situation_id, pause_situation_id)
         VALUES (?, ?, 'medication', ?, 'must', 1, ?, ?, ?)`
      )
      .run(
        profileId,
        name,
        on ? "situational" : "daily",
        on ? situation : null,
        on ? sid : null,
        on ? null : sid
      ).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 tab', 'Morning', 'any', 0)`
  ).run(itemId);
}

// The item names the Morning reminder would carry for `date`.
function morningNames(profileId: number, date: string): string[] {
  return collectWindowDoses(profileId, "Morning", date).map((e) => e.item.name);
}

// Declare `situation` and BACKDATE its start, so the profile arrives at "active since
// day-N" — the state the real writer can only reach by having been toggled then.
function activeSince(profileId: number, situation: string, days: number): void {
  setActiveSituations(profileId, [situation]);
  setProfileSetting(
    profileId,
    "situation_events",
    serializeSituationEvents(
      [],
      diffSituations([], [situation], shiftDateStr(today(profileId), -days))
    )
  );
}

const ITEM = "Loratadine";

describe("a past-day reminder scores against that day's situations (#3973)", () => {
  // Both directions of one toggle. `before`/`after` are [past day, today] membership, and
  // the BEFORE row is asserted first: without it "the past day did not change" is equally
  // true of a fixture whose dose could never appear on any day.
  it.each([
    {
      what: "declared TODAY does not reach back",
      how: "due-on" as const,
      seed: (_p: number) => {},
      toggle: (p: number) => setActiveSituations(p, ["Travel"]),
      before: [false, false],
      after: [false, true],
    },
    {
      what: "un-declared TODAY does not erase a day it was on",
      how: "due-on" as const,
      seed: (p: number) => activeSince(p, "Travel", 5),
      toggle: (p: number) => setActiveSituations(p, []),
      before: [true, true],
      after: [true, false],
    },
    {
      // The PAUSE hold (#1296) reads the same set, so it dates with it: declaring the
      // pausing situation today must not retroactively silence a day it was owed.
      what: "a pause situation declared TODAY does not silence a past day",
      how: "paused-by" as const,
      seed: (_p: number) => {},
      toggle: (p: number) => setActiveSituations(p, ["Travel"]),
      before: [true, true],
      after: [true, false],
    },
  ])("$what", ({ how, seed, toggle, before, after }) => {
    const p = newProfile();
    seedItem(p, ITEM, "Travel", how);
    const past = shiftDateStr(today(p), -2);
    seed(p);

    // PRECONDITION — the fixture really is in the state this case claims to start from.
    expect([
      morningNames(p, past).includes(ITEM),
      morningNames(p, today(p)).includes(ITEM),
    ]).toEqual(before);

    toggle(p);

    expect([
      morningNames(p, past).includes(ITEM),
      morningNames(p, today(p)).includes(ITEM),
    ]).toEqual(after);
  });
});

// A sleep_min session on `wakeDay` of `minutes` (window ending at wake time), stored as
// UTC instants so wall clock == instant under the UTC profile above.
function night(wakeDay: string, minutes: number): NormMetricSample {
  const h = String(Math.floor(minutes / 60)).padStart(2, "0");
  const m = String(minutes % 60).padStart(2, "0");
  return {
    metric: "sleep_min",
    date: wakeDay,
    started_at: `${shiftDateStr(wakeDay, -1)}T23:00:00Z`,
    ended_at: `${wakeDay}T${h}:${m}:00Z`,
    value: minutes,
  };
}

describe("the TODAY branch keeps the derived widening (#1292/#1298)", () => {
  it("a rough night makes a sleep-keyed item due today and on no past day", () => {
    const p = newProfile();
    seedItem(p, "Magnesium Glycinate", "Poor sleep", "due-on");
    const anchor = today(p);
    // Six ~8h nights, then 5h last night → a MEASURED rough night, derived-on today.
    const nights = [1, 2, 3, 4, 5, 6].map((i) =>
      night(shiftDateStr(anchor, -i), 480)
    );
    upsertMetricSamples(p, [...nights, night(anchor, 300)], "health-connect");

    // Today's reminder sees it through the declared ∪ derived union...
    expect(morningNames(p, anchor)).toContain("Magnesium Glycinate");
    // ...and no past day does: "Poor sleep" was never DECLARED, and the derived verdict
    // is a statement about now that may not be dated backwards.
    for (const d of [1, 2, 3])
      expect(morningNames(p, shiftDateStr(anchor, -d))).toEqual([]);
  });
});
