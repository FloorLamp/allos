// DB INTEGRATION TIER — the offline dose schedule and the household card read the same
// situations the member's own page reads (#5167).
//
// Every online surface that decides whether a dose is DUE moved to the effective
// resolver — declared ∪ derived, dated per day (`getEffectiveActiveSituations`, #1360 /
// #3993). Two surfaces did not come with them and asked `getActiveSituations`, which is
// the declared half alone as of now:
//
//   • the offline snapshot builder (`lib/offline/snapshot-build.ts`), and
//   • the /household card's x/y.
//
// So both had NEITHER the holding NOR the widening, and the two failures point opposite
// ways, which is why each gets its own case here: a dose the page HOLDS for a derived
// pause was offered, and a dose whose `situational` trigger the app DERIVED was omitted.
//
// OFFLINE IS A SURFACE A PERSON ACTS ON. This is a divergence about what was owed, not
// about what is displayed: they tap what the snapshot offered and come back online to a
// schedule that says the dose was never due. The household card is read by a caregiver
// deciding whether to go and ask.
//
// Fixtures are 100% synthetic (a throwaway per-file DB via setup.ts). No AI, no network.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { db, today } from "@/lib/db";
import { shiftDateStr } from "@/lib/date";
import { setTimezone } from "@/lib/settings";
import {
  upsertMetricSamples,
  type NormMetricSample,
} from "@/lib/integrations/normalize";
import { resolveSituationId } from "@/lib/settings/profile-attrs";
import { BUILTIN_POOR_SLEEP_SITUATION } from "@/lib/derived-situations";
import { getEffectiveActiveSituations } from "@/lib/queries/derived-situations";
import {
  getIntakeItems,
  getIntakeDoses,
  getTakenDoseIds,
  getActivitiesByDate,
} from "@/lib/queries";
import { intakeAdherenceToday } from "@/lib/household";
import { buildSnapshot, snapshotContext } from "@/lib/offline/snapshot-build";
import type { DoseScheduleEntry } from "@/lib/offline/snapshots";

let seq = 0;

function newProfile(): number {
  const id = Number(
    db
      .prepare("INSERT INTO profiles (name) VALUES (?)")
      .run(`Offline Situations ${seq++}`).lastInsertRowid
  );
  setTimezone(id, "UTC");
  return id;
}

// A sleep_min session ending on `wakeDay`, the derived-situations fixture shape: stored
// as UTC instants, so under the UTC zone above wall clock and instant agree.
function night(wakeDay: string, minutes: number): NormMetricSample {
  const endH = Math.floor(minutes / 60);
  const endM = minutes % 60;
  return {
    metric: "sleep_min",
    date: wakeDay,
    started_at: `${shiftDateStr(wakeDay, -1)}T23:00:00Z`,
    ended_at: `${wakeDay}T${String(endH).padStart(2, "0")}:${String(endM).padStart(2, "0")}:00Z`,
    value: minutes,
  };
}

// An ~8h baseline with a 5h night on each of `roughOffsets` (day offsets back from
// today). Nobody DECLARES anything here — that is the whole point: the situation these
// cases turn on is one the app derived from measurement, which is exactly the half
// `getActiveSituations` cannot see.
function seedRoughNight(profileId: number, roughOffsets: number[] = [0]): void {
  const anchor = today(profileId);
  const sessions: NormMetricSample[] = [];
  for (let i = 6; i >= 0; i--)
    sessions.push(
      night(shiftDateStr(anchor, -i), roughOffsets.includes(i) ? 300 : 480)
    );
  upsertMetricSamples(profileId, sessions, "health-connect");
}

/** A daily item the situation PAUSES, or a situational item it TRIGGERS. */
function seedItem(
  profileId: number,
  name: string,
  how: "paused-by" | "due-on"
): number {
  const sid = resolveSituationId(profileId, BUILTIN_POOR_SLEEP_SITUATION)!;
  const on = how === "due-on";
  const itemId = Number(
    db
      .prepare(
        `INSERT INTO intake_items
           (profile_id, name, kind, condition, obligation, active,
            situation, situation_id, pause_situation_id)
         VALUES (?, ?, 'supplement', ?, 'should', 1, ?, ?, ?)`
      )
      .run(
        profileId,
        name,
        on ? "situational" : "daily",
        on ? BUILTIN_POOR_SLEEP_SITUATION : null,
        on ? sid : null,
        on ? null : sid
      ).lastInsertRowid
  );
  db.prepare(
    `INSERT INTO intake_item_doses (item_id, amount, time_of_day, food_timing, sort)
     VALUES (?, '1 tab', 'Morning', 'any', 0)`
  ).run(itemId);
  return itemId;
}

/** The names the offline dose schedule would put on the device. */
function offlineDoseNames(profileId: number): string[] {
  const snap = buildSnapshot(
    "dose-schedule",
    snapshotContext(profileId, 1),
    new Date()
  );
  return (snap.data as { entries: DoseScheduleEntry[] }).entries.map(
    (d) => d.name
  );
}

// THE HOUSEHOLD HALF IS PINNED HERE AND BY THE SOURCE SCAN BELOW, and the split is
// worth stating rather than hiding. /household's card loop is INLINE in the page: the
// module it hands its reads to (`lib/household.ts`) is pure by its own stated design —
// "the page fetches each profile's data with the existing per-profile query functions
// and hands the raw results to these helpers" — so there is no seam a runtime test can
// hold, and building one would contradict that design for the sake of a test.
//
// What this helper pins is the ANSWER: given the effective situations, the card's x/y
// and the snapshot's rows name the same doses. What it cannot pin is that the page asks
// for them, because it rebuilds the page's context rather than calling it. That one bit
// is the source scan's, which is the same trade `detected-finish-tick-order.test.ts`
// makes for the same reason.
/** The card's x/y, built from the same reads /household's card loop makes. */
function householdAdherence(profileId: number): { taken: number; due: number } {
  const day = today(profileId);
  return intakeAdherenceToday(
    getIntakeDoses(profileId),
    new Map(
      getIntakeItems(profileId)
        .filter((i) => i.active)
        .map((i) => [i.id, i])
    ),
    {
      date: day,
      isWorkoutDay: getActivitiesByDate(profileId, day).length > 0,
      activeSituations: getEffectiveActiveSituations(profileId, day),
    },
    getTakenDoseIds(profileId, day)
  );
}

describe("the offline schedule reads the situations the page reads (#5167)", () => {
  it("holds a dose a derived pause holds", () => {
    const p = newProfile();
    seedItem(p, "Magnesium", "paused-by");
    seedItem(p, "Vitamin D", "paused-by");
    // Before the night is measured, both are ordinary daily doses.
    expect(offlineDoseNames(p).sort()).toEqual(["Magnesium", "Vitamin D"]);

    seedRoughNight(p);
    // Nobody declared anything; the app derived the rough night, and the medications
    // page holds both. The snapshot must hold them too, or it offers a dose that was
    // never owed.
    expect(offlineDoseNames(p)).toEqual([]);
  });

  it("offers a dose a derived trigger adds", () => {
    const p = newProfile();
    seedItem(p, "Electrolytes", "due-on");
    // A situational item with its situation inactive is not due, which is the control
    // that keeps the case below from passing for any reason at all.
    expect(offlineDoseNames(p)).toEqual([]);

    seedRoughNight(p);
    expect(offlineDoseNames(p)).toEqual(["Electrolytes"]);
  });

  it("asks about the snapshot's OWN day, not any recent one", () => {
    const p = newProfile();
    seedItem(p, "Magnesium", "paused-by");
    // Rough two nights ago and slept well since. The resolver is dated, so the pause
    // belongs to that day and today's dose stands — an "as of now" reading with any
    // lookback in it would hold a dose nobody is holding.
    seedRoughNight(p, [2]);
    expect(offlineDoseNames(p)).toEqual(["Magnesium"]);
  });

  it("stays inside its own profile", () => {
    const rough = newProfile();
    const rested = newProfile();
    for (const p of [rough, rested]) {
      seedItem(p, "Magnesium", "paused-by");
      seedItem(p, "Electrolytes", "due-on");
    }
    seedRoughNight(rough);

    expect(offlineDoseNames(rough)).toEqual(["Electrolytes"]);
    expect(offlineDoseNames(rested)).toEqual(["Magnesium"]);
  });
});

describe("the household card and the offline schedule agree (#5167)", () => {
  // ONE DAY, ONE ANSWER, ACROSS TWO SURFACES. A caregiver reading "0/1" on a card while
  // the member's phone offers the dose has no way to tell which is the schedule — and
  // the card is what they act on when they decide whether to go and ask.
  it("counts the doses the snapshot offers, on a derived pause and a derived trigger", () => {
    const p = newProfile();
    seedItem(p, "Magnesium", "paused-by");
    seedItem(p, "Electrolytes", "due-on");

    expect(householdAdherence(p)).toEqual({ taken: 0, due: 1 });
    expect(offlineDoseNames(p)).toEqual(["Magnesium"]);

    seedRoughNight(p);
    // The pause takes one away and the trigger adds one back: the DUE count is the same
    // number for a different reason, and the two surfaces name the same dose.
    expect(householdAdherence(p)).toEqual({ taken: 0, due: 1 });
    expect(offlineDoseNames(p)).toEqual(["Electrolytes"]);
  });
});

describe("the /household card asks for the effective situations (#5167)", () => {
  // A SOURCE SCAN, because the card loop is inline in the page and there is nothing to
  // call — see the note above `householdAdherence`. The one thing that can regress is
  // the reader the page names, and that is exactly what this reads. It is deliberately
  // narrow: it asserts which reader the page CALLS, not how the file is laid out, so an
  // unrelated edit cannot red it. The name appearing in the comment that explains the
  // change is not a regression, which is why this looks for the open paren.
  it("does not call the declared-only reader", () => {
    const source = readFileSync(
      join(process.cwd(), "app/(app)/household/page.tsx"),
      "utf8"
    );
    expect(source).toContain("getEffectiveActiveSituations");
    expect(source).not.toMatch(/getActiveSituations\(/);
  });
});
