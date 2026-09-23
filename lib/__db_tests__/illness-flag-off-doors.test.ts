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
import {
  endEpisodeAction,
  promoteEpisodeToConditionAction,
} from "@/app/(app)/medical/episodes/actions";
import { toggleSituationIllnessType } from "@/app/(app)/nutrition/intake-actions";
import {
  getSituations,
  getIllnessSituations,
  getActiveSituations,
  hasActiveIllnessSituation,
  setActiveSituations,
  setSituationIllnessType,
} from "@/lib/settings/profile-attrs";
import {
  createEpisodeRow,
  listEpisodeRows,
  openEpisodeIdForDate,
} from "@/lib/illness-episode-store";
import { getSituationEvents, setTimezone } from "@/lib/settings";
import { shiftDateStr } from "@/lib/date";
import { seedActor, fd } from "@/lib/__action_tests__/harness";
import type { WriteAuthorizedProfileId } from "@/lib/auth";

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

// ── THE DOOR'S START DAY (#5969) ─────────────────────────────────────────────
//
// The bar can be showing Yesterday, and the reading the fever offer answers was logged
// for that day. Both doors post the bar's day; the row and its start event start there,
// and today's read still finds the row. The day is bounded like every dated write: a
// day after today is refused with no row written, and no day means today.
describe("the door's start day (#5969)", () => {
  it("a posted day starts the row and its start event there, and today's read finds it", async () => {
    const { profile } = seedActor({ profileName: "yesterday-door" });
    const yesterday = shiftDateStr(today(profile.id), -1);

    const res = await activateIllnessForSymptoms(fd({ date: yesterday }));
    expect(res.ok).toBe(true);
    const rows = openEpisodes(profile.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].start_date).toBe(yesterday);
    expect(res.episodeId).toBe(rows[0].id);
    expect(openEpisodeIdForDate(profile.id, yesterday)).toBe(rows[0].id);
    expect(getSituationEvents(profile.id)).toEqual([
      { date: yesterday, situation: ILLNESS, change: "start" },
    ]);
  });

  it.each([
    { name: "no posted day starts today", offset: null, opens: true },
    { name: "a day after today is refused", offset: 1, opens: false },
  ])("$name", async ({ offset, opens }) => {
    const { profile } = seedActor({ profileName: `door-day-${offset}` });
    const day = offset == null ? null : shiftDateStr(today(profile.id), offset);

    const res = await activateIllnessForSymptoms(fd({ date: day }));
    expect(res.ok).toBe(opens);
    const rows = openEpisodes(profile.id);
    if (opens) {
      expect(rows).toHaveLength(1);
      expect(rows[0].start_date).toBe(today(profile.id));
    } else {
      expect(rows).toEqual([]);
      expect(getActiveSituations(profile.id)).not.toContain(ILLNESS);
    }
  });
});

// ── A BACKDATED DOOR AFTER A CLOSE (#6007) ───────────────────────────────────
//
// Mark better today, then answer yesterday's leftover fever: the door's start day falls
// inside the episode just closed. The same illness continues, so the door reopens that
// row rather than opening a second one over the same days.
describe("a backdated door after a close (#6007)", () => {
  function closedEpisode(name: string) {
    const { profile } = seedActor({ profileName: name });
    setTimezone(profile.id, "America/New_York");
    const day = (offset: number) => shiftDateStr(today(profile.id), offset);
    return { profile, day };
  }

  it("reopens the episode it overlaps, and its condition, instead of opening a second", async () => {
    const { profile, day } = closedEpisode("backdated-reopen");
    const opened = await activateIllnessForSymptoms(fd({ date: day(-3) }));
    await endEpisodeAction(fd({ episodeId: opened.episodeId }));
    await promoteEpisodeToConditionAction(fd({ episodeId: opened.episodeId }));

    const res = await activateIllnessForSymptoms(fd({ date: day(-1) }));
    expect(res.ok).toBe(true);
    expect(listEpisodeRows(profile.id)).toMatchObject([
      { id: opened.episodeId, start_date: day(-3), end_date: null },
    ]);
    expect(
      db
        .prepare(
          `SELECT status, resolved_date FROM conditions
            WHERE profile_id = ? AND source = 'episode'`
        )
        .all(profile.id)
    ).toEqual([{ status: "active", resolved_date: null }]);
  });

  it("a backdated day past an older episode still opens a new row", async () => {
    const { profile, day } = closedEpisode("backdated-new");
    const older = createEpisodeRow(
      profile.id as WriteAuthorizedProfileId,
      ILLNESS,
      day(-10),
      day(-6)
    );

    const res = await activateIllnessForSymptoms(fd({ date: day(-1) }));
    expect(res.ok).toBe(true);
    expect(listEpisodeRows(profile.id)).toMatchObject([
      { id: res.episodeId, start_date: day(-1), end_date: null },
      { id: older, start_date: day(-10), end_date: day(-6) },
    ]);
  });
});
