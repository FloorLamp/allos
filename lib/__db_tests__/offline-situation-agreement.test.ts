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
// OFFLINE IS WHAT SOMEONE READS WITH NO SIGNAL. /offline renders the schedule as rows
// with no control on them, so the acting happens in the world rather than in the app:
// this is what tells a person whether a dose is owed when nothing else can, and they
// take it or skip it on that. The household card is the same shape one seat over — a
// caregiver deciding whether to go and ask. Neither is a display divergence.
//
// ── THE HOUSEHOLD HALF IS CALLED, NOT SCANNED (second falsifying pass) ───────
// The card loop assembled its day context inline in the page, so the only guard
// available was a source scan of `page.tsx`. Two mutants walked through it: a SECOND
// `getEffectiveActiveSituations(profileIds[0], day)` call unioned in below the pinned
// one — scoring every card partly against the first accessible profile's situations —
// and a comment naming the reader with its arguments, which satisfied the positive
// assertion on its own. Both were byte-identical green across the whole db tier.
//
// The defect they demonstrate is a COMPOSITION one: two correctly scoped readers, with
// one profile's honest answer handed into another profile's context. `profile-scoping`
// and `scoping` both ask whether a READER is scoped, so neither can see it, and no
// amount of scanning holds a shape whose vectors are "add a call" and "add a comment".
// `intakeAdherenceOn(profileId, date)` in `lib/queries/household.ts` is the seam that
// does: the subject and the day are its arguments, and the cases below call it.
//
// Fixtures are 100% synthetic (a throwaway per-file DB via setup.ts). No AI, no network.

import { describe, it, expect } from "vitest";
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
import { intakeAdherenceOn } from "@/lib/queries/household";
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

    expect(intakeAdherenceOn(p, today(p))).toEqual({ taken: 0, due: 1 });
    expect(offlineDoseNames(p)).toEqual(["Magnesium"]);

    seedRoughNight(p);
    // The pause takes one away and the trigger adds one back: the DUE count is the same
    // number for a different reason, and the two surfaces name the same dose.
    expect(intakeAdherenceOn(p, today(p))).toEqual({ taken: 0, due: 1 });
    expect(offlineDoseNames(p)).toEqual(["Electrolytes"]);
  });

  it("answers for the subject it is asked about, not another member", () => {
    // THE MUTANT THE SOURCE SCAN COULD NOT SEE. One member's rough night must not hold
    // another member's dose: a card that reads 0/0 where the truth is 0/1 has lost the
    // one signal on it that says a dose is owed, and the caregiver never goes to ask.
    const rough = newProfile();
    const rested = newProfile();
    seedItem(rested, "Magnesium", "paused-by");
    seedRoughNight(rough);

    expect(getEffectiveActiveSituations(rough, today(rough)).size).toBe(1);
    expect(intakeAdherenceOn(rested, today(rested))).toEqual({
      taken: 0,
      due: 1,
    });
  });

  it("answers for the day it is asked about", () => {
    // The other argument, pinned the same way: the rough night is two days back, so
    // today's card counts the dose and the card for that day holds it.
    const p = newProfile();
    seedItem(p, "Magnesium", "paused-by");
    seedRoughNight(p, [2]);
    const rough = shiftDateStr(today(p), -2);

    expect(intakeAdherenceOn(p, today(p))).toEqual({ taken: 0, due: 1 });
    expect(intakeAdherenceOn(p, rough)).toEqual({ taken: 0, due: 0 });
  });
});
