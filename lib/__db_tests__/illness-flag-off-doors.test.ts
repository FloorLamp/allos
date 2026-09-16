// ISSUE #5271 — the illness flag going off must not wedge both start doors forever.
//
// THE SCENARIO, end to end through the real actions: start an episode, use the shipped
// "is this an illness" toggle to turn the flag off for that situation, then tap either
// start door again. Before the fix `activateIllnessForSymptoms` answered ok with
// `episodeId: null` on that tap and on every retry after it, while both doors kept
// rendering — a visible dead end.
//
// WHY IT LIVES AT THIS TIER. The defect exists only in the gap between a write in
// lib/settings/profile-attrs.ts and reads spread across the action, lib/situations.ts and
// the episode store; each half looks correct alone. So this drives the real
// toggleSituationIllnessType and activateIllnessForSymptoms server actions against real
// SQLite and asserts the STORED rows, not the actions' own answers.
//
// The two readers that disagreed are asserted separately (hasActiveIllnessSituation vs
// getActiveSituations, and getIllnessSituations' flagged filter) so that breaking either
// one reddens the case that depends on it rather than the whole file.

import { describe, it, expect } from "vitest";
import { db, today } from "@/lib/db";
import { activateIllnessForSymptoms } from "@/app/(app)/symptom-actions";
import { toggleSituationIllnessType } from "@/app/(app)/nutrition/intake-actions";
import {
  getSituations,
  getIllnessSituations,
  getActiveSituations,
  hasActiveIllnessSituation,
  setActiveSituations,
  setSituationIllnessType,
} from "@/lib/settings/profile-attrs";
import { openEpisodeIdForDate } from "@/lib/illness-episode-store";
import { seedActor, fd } from "@/lib/__action_tests__/harness";

const ILLNESS = "Illness";

function situationRow(profileId: number, name: string) {
  return getSituations(profileId).find((s) => s.name === name);
}

function openEpisodes(profileId: number) {
  return db
    .prepare(
      `SELECT id, situation, start_date, end_date FROM illness_episodes
        WHERE profile_id = ? AND end_date IS NULL ORDER BY id`
    )
    .all(profileId) as {
    id: number;
    situation: string;
    start_date: string | null;
    end_date: string | null;
  }[];
}

// What the two doors render from: the symptom card's "Mark as illness" bridge shows when
// nothing is being tracked (suggestIllnessActivation), and the fever offer's "Open an
// episode" shows when there is no open episode. Both read the same list the quick-entry
// gather builds, so one helper stands for both.
function trackingIllness(profileId: number): string[] {
  return getIllnessSituations(profileId)
    .filter((s) => s.active)
    .map((s) => s.name);
}

describe("illness flag off — the start doors keep working (#5271)", () => {
  it("the flag toggle cannot un-flag the built-in container, so re-activation keeps returning an episode", async () => {
    const { profile } = seedActor({ profileName: "flag-off" });

    // Door works once, from nothing — the reference every later tap is compared against.
    const first = await activateIllnessForSymptoms();
    expect(first.ok).toBe(true);
    expect(first.episodeId).not.toBeNull();
    expect(openEpisodes(profile.id)).toHaveLength(1);

    // The shipped toggle aims the illness flag at the built-in container.
    const off = await toggleSituationIllnessType(fd({ situation: ILLNESS }));
    expect(off.ok).toBe(true);

    // THE WEDGE STATE IS NEVER MINTED. `illness_type = 0` with `active = 1` on the
    // built-in is the state the issue measured; the row keeps its identity instead.
    expect(situationRow(profile.id, ILLNESS)).toMatchObject({
      active: 1,
      illness_type: 1,
    });
    // So the two readers that disagreed now agree, and the open row survives.
    expect(getActiveSituations(profile.id)).toContain(ILLNESS);
    expect(hasActiveIllnessSituation(profile.id)).toBe(true);
    expect(trackingIllness(profile.id)).toEqual([ILLNESS]);
    expect(openEpisodes(profile.id)).toHaveLength(1);
    expect(openEpisodes(profile.id)[0].id).toBe(first.episodeId);

    // The door still answers with a real episode id rather than null.
    const second = await activateIllnessForSymptoms();
    expect(second.ok).toBe(true);
    expect(second.episodeId).toBe(first.episodeId);
    expect(openEpisodeIdForDate(profile.id, today(profile.id))).toBe(
      first.episodeId
    );

    // "PERMANENTLY" IS THE HALF ONE GREEN TAP CANNOT SEE. Before the fix every retry
    // after the first failure returned null too, so a fix that works once and re-wedges
    // is the same bug. The retries are asserted, not assumed — and so is the absence of
    // a duplicate row, which is the other way a retry loop can go wrong.
    for (const attempt of [2, 3]) {
      const again = await activateIllnessForSymptoms();
      expect(again.ok, `retry #${attempt}`).toBe(true);
      expect(again.episodeId, `retry #${attempt}`).toBe(first.episodeId);
      expect(openEpisodes(profile.id), `retry #${attempt}`).toHaveLength(1);
    }

    // Toggling repeatedly does not drift either: the built-in is flagged by identity,
    // so N taps and one tap leave the same row.
    for (let i = 0; i < 3; i++)
      await toggleSituationIllnessType(fd({ situation: ILLNESS }));
    expect(situationRow(profile.id, ILLNESS)).toMatchObject({
      active: 1,
      illness_type: 1,
    });
    expect(openEpisodes(profile.id)).toHaveLength(1);
  });

  it("case and whitespace cannot spell around the built-in's identity", async () => {
    // The vocabulary is NOCASE-matched (#560), so " iLLness " is the SAME row. A refusal
    // keyed on the exact string would be no refusal at all.
    const { profile } = seedActor({ profileName: "spelling" });
    await activateIllnessForSymptoms();
    await toggleSituationIllnessType(fd({ situation: "  iLLness  " }));
    expect(situationRow(profile.id, ILLNESS)).toMatchObject({
      active: 1,
      illness_type: 1,
    });
    expect(getSituations(profile.id)).toHaveLength(1); // no second row was minted
    expect(openEpisodes(profile.id)).toHaveLength(1);
  });

  it("a user situation still opts out and KEEPS its own active state", async () => {
    // THE STATE THE FIX MUST NOT DESTROY. "flag off but active = 1" is not damage to be
    // repaired: it is what every Travel/High-stress row looks like, and the existing
    // opt-in/opt-out contract (lib/__db_tests__/symptom-log.test.ts) depends on it.
    // Clearing `active` on opt-out would turn the toggle into a hidden situation-
    // deactivate button; refusing the opt-out would take the toggle away entirely. The
    // scoped refusal does neither.
    const { profile } = seedActor({ profileName: "keeps-active" });

    setActiveSituations(profile.id, ["Kid sick", "Travel"]);
    setSituationIllnessType(profile.id, "Kid sick", true);
    expect(situationRow(profile.id, "Kid sick")).toMatchObject({
      active: 1,
      illness_type: 1,
    });
    expect(openEpisodes(profile.id).map((e) => e.situation)).toEqual([
      "Kid sick",
    ]);
    expect(hasActiveIllnessSituation(profile.id)).toBe(true);

    // Opt out: the episode closes, the SITUATION stays on.
    setSituationIllnessType(profile.id, "Kid sick", false);
    expect(situationRow(profile.id, "Kid sick")).toMatchObject({
      active: 1,
      illness_type: 0,
    });
    expect(openEpisodes(profile.id)).toEqual([]);
    expect(getActiveSituations(profile.id)).toContain("Kid sick");
    expect(hasActiveIllnessSituation(profile.id)).toBe(false);
    expect(trackingIllness(profile.id)).toEqual([]);
    // Travel — active, never flagged — is the same shape and untouched throughout.
    expect(situationRow(profile.id, "Travel")).toMatchObject({
      active: 1,
      illness_type: 0,
    });

    // And opting back in reopens a container, so the round trip is lossless.
    setSituationIllnessType(profile.id, "Kid sick", true);
    expect(openEpisodes(profile.id).map((e) => e.situation)).toEqual([
      "Kid sick",
    ]);
    expect(hasActiveIllnessSituation(profile.id)).toBe(true);
  });

  it("an INACTIVE built-in stays inactive, and flagging it opens nothing", async () => {
    // The refusal is about the flag alone. `active` is still the other half of "episode
    // container", so a built-in that is off must not acquire an episode from a toggle —
    // which is what a refusal implemented as "force the container open" would do.
    const { profile } = seedActor({ profileName: "inactive-builtin" });
    await activateIllnessForSymptoms();
    setActiveSituations(profile.id, []); // the user turns the situation off
    expect(situationRow(profile.id, ILLNESS)).toMatchObject({ active: 0 });
    expect(openEpisodes(profile.id)).toEqual([]);

    await toggleSituationIllnessType(fd({ situation: ILLNESS }));
    expect(situationRow(profile.id, ILLNESS)).toMatchObject({
      active: 0,
      illness_type: 1,
    });
    expect(openEpisodes(profile.id)).toEqual([]);
    expect(hasActiveIllnessSituation(profile.id)).toBe(false);
    expect(trackingIllness(profile.id)).toEqual([]);

    // And the door still opens one from there, which is the #4962 path.
    const res = await activateIllnessForSymptoms();
    expect(res.episodeId).not.toBeNull();
    expect(openEpisodes(profile.id)).toHaveLength(1);
  });
});
