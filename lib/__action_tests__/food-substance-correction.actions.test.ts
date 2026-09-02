// SERVER-ACTION TIER — the record's food correction, on a MINOR's row (#4072).
//
// The `⋯` correction rendered all 25 food groups on any row it was drawn on, including
// a minor's under `?view=everyone`, and `updateFoodLogEvent` had no age gate. Measured
// on a caregiver holding a `write` grant on a 9-year-old: correcting the child's
// `berries` row to `alcohol` answered `{ok:true}`, wrote the row, and the row then left
// the record entirely — the food gather excludes substance groups and the substance
// gather is minor-gated — while still counting in `getAllSubstanceDailyTotals`.
//
// Two halves are fixed here and they are deliberately the same question asked twice:
// the record does not OFFER a group it would refuse (an option that always refuses is
// worse than one that is not offered), and the WRITE asks it where it is authoritative,
// because the offer is markup and a post is not. That is #4067's substance-correction
// gate, one domain over.
//
// THE DISAPPEARANCE ITSELF IS NOT FIXED HERE and is not asserted away either: the
// exclusion that produces it is the 2026-08-29 owner ruling, guarded in
// lib/__db_tests__/history-gather.test.ts by the measurement that decided it. This file
// pins what that ruling and this issue agree on — that the record must stop putting a
// row INTO that state — and the last case below states the disappearance as it stands,
// so whichever way the owner rules, the two files disagree loudly rather than quietly.
//
// EVERY ASSERTION READS THE STORE. `updateFoodLogEvent` answers a `{ok:false}` union
// rather than throwing, and a refusal and a write onto the wrong row look identical in
// the promise.

import { describe, it, expect } from "vitest";
import { db } from "@/lib/db";
import { setStoredAge } from "@/lib/settings";
import { updateFoodLogEvent } from "@/app/(app)/nutrition/actions";
import { logFoodServingCore } from "@/lib/food-log-write";
import { gatherHistoryLog } from "@/lib/history";
import { ALCOHOL_FOOD_GROUP } from "@/lib/substance-use";
import { createLogin, createProfile, actAs, fd } from "./harness";

const DATE = "2026-07-20";

function groupOf(eventId: number): string | undefined {
  return (
    db
      .prepare("SELECT group_key FROM food_log_events WHERE id = ?")
      .get(eventId) as { group_key: string } | undefined
  )?.group_key;
}

function seedServing(profileId: number, group: string): number {
  const outcome = logFoodServingCore(profileId, group, DATE, "page");
  if (outcome.kind !== "logged")
    throw new Error(`seed failed: ${outcome.kind} for ${group}`);
  return outcome.eventId;
}

// A caregiver login holding a WRITE grant on both its own profile and the member's, so
// a refusal below can only come from the age gate and never from a missing grant.
function household(memberAge: number): {
  caregiver: { id: number };
  member: { id: number };
} {
  const login = createLogin({ role: "member" });
  const caregiver = createProfile(`caregiver ${memberAge}`, login.id);
  const member = createProfile(`member ${memberAge}`, login.id);
  setStoredAge(caregiver.id, 41);
  setStoredAge(member.id, memberAge);
  actAs(login, caregiver);
  return { caregiver, member };
}

describe("correcting a food row into a substance group (#4072)", () => {
  it("refuses the move on a KNOWN MINOR's row, and lands it on an adult's", async () => {
    for (const [age, expected] of [
      [9, "berries"],
      [41, ALCOHOL_FOOD_GROUP],
    ] as const) {
      const { member } = household(age);
      const eventId = seedServing(member.id, "berries");

      // THE FIXTURE REACHES THE STATE FIRST. The caregiver is acting as someone else,
      // and the ordinary correction this login is entitled to make on that row LANDS —
      // so the refusal below is the age gate, not a grant this test forgot to give.
      const control = await updateFoodLogEvent(
        fd({
          event_id: eventId,
          profile_id: member.id,
          group_key: "eggs",
          date: DATE,
        })
      );
      expect(control.ok, `age ${age} control correction`).toBe(true);
      expect(groupOf(eventId)).toBe("eggs");

      const moved = await updateFoodLogEvent(
        fd({
          event_id: eventId,
          profile_id: member.id,
          group_key: ALCOHOL_FOOD_GROUP,
          date: DATE,
        })
      );
      expect(moved.ok, `age ${age} move into a substance group`).toBe(
        age !== 9
      );
      expect(groupOf(eventId), `age ${age} stored group`).toBe(
        age === 9 ? "eggs" : ALCOHOL_FOOD_GROUP
      );
    }
  });

  it("still corrects a minor's EXISTING substance row rather than stranding it", async () => {
    const { member } = household(9);
    // Reachable without the record: the nutrition bar's own catalog is unfiltered and
    // a profile may act as itself. A gate that refused this would make the row's meal
    // and its eating time permanently uncorrectable — the failure this issue is about,
    // wearing the other face.
    const eventId = seedServing(member.id, ALCOHOL_FOOD_GROUP);
    const corrected = await updateFoodLogEvent(
      fd({
        event_id: eventId,
        profile_id: member.id,
        group_key: ALCOHOL_FOOD_GROUP,
        date: DATE,
        meal_slot: "Evening",
      })
    );
    expect(corrected.ok).toBe(true);
    expect(
      (
        db
          .prepare("SELECT meal_slot FROM food_log_events WHERE id = ?")
          .get(eventId) as { meal_slot: string | null }
      ).meal_slot
    ).toBe("Evening");
  });

  it("the record's offer asks the same question the write does", async () => {
    const loginId = createLogin({ role: "admin" }).id;
    for (const [age, offered] of [
      [9, false],
      [41, true],
    ] as const) {
      const { member } = household(age);
      seedServing(member.id, "berries");
      const rows = gatherHistoryLog(member.id, { loginId, limit: 50 }).rows;
      const food = rows.filter((row) => row.edit?.kind === "food");
      // The row has to be on the record before its offer means anything.
      expect(food.map((row) => row.title), `age ${age}`).toEqual(["Berries"]);
      const edit = food[0].edit;
      expect(edit?.kind === "food" && edit.substanceCorrectable).toBe(offered);
    }
  });

  it("states the standing disappearance rather than assuming it away", () => {
    const loginId = createLogin({ role: "admin" }).id;
    const { member } = household(9);
    seedServing(member.id, ALCOHOL_FOOD_GROUP);
    // The row exists and the day counter carries it…
    expect(groupOf(seedServing(member.id, "berries"))).toBe("berries");
    // …but the record shows only the ordinary serving: the food gather excludes
    // substance groups (the 2026-08-29 ruling) and the substance gather is minor-gated,
    // so the drink is on neither half. This is the open half of #4072, pinned here so
    // an owner ruling either way has to come through this assertion.
    expect(
      gatherHistoryLog(member.id, { loginId, limit: 50 }).rows.map(
        (row) => row.title
      )
    ).toEqual(["Berries"]);
  });
});
