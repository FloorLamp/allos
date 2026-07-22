// SERVER-ACTION TIER — the #1154 §B write-path hook: saveActivity arms the
// delayed post-workout dispatch queue for a TODAY-dated save (live Finish or
// retroactive completed log), re-arms on a re-save (coalescing), and never arms
// for a past-dated save. The queue's timer semantics are pinned in the pure
// tier; here we assert the ACTION arms it and returns without awaiting the
// dispatch (non-blocking).

import { describe, it, expect, beforeEach } from "vitest";
import { today } from "@/lib/db";
import { saveActivity } from "@/app/(app)/journal/actions";
import {
  pendingPostWorkoutDispatchKeys,
  flushPostWorkoutDispatches,
} from "@/lib/notifications/post-workout-queue";
import { createLogin, createProfile, actAs, fd } from "./harness";

const cardio = JSON.stringify([
  { name: "Running", type: "cardio", distance: null, duration_min: 30 },
]);

beforeEach(async () => {
  // Drain timers a previous case armed so pending-key assertions are exact.
  // (Flushing runs the real dispatch core, which no-ops here: no channels are
  // configured in this tier, so nothing sends and no marker is stamped.)
  await flushPostWorkoutDispatches();
});

describe("saveActivity arms the delayed post-workout dispatch (#1154 §B)", () => {
  it("a today-dated completed save arms the queue (and returns immediately)", async () => {
    const login = createLogin();
    const profile = createProfile("pw-arm", login.id);
    actAs(login, profile);

    const res = await saveActivity(
      fd({
        type: "cardio",
        title: "Evening run",
        date: today(profile.id),
        start_time: "18:00",
        end_time: "18:45",
        components: cardio,
        sets: "[]",
      })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(pendingPostWorkoutDispatchKeys()).toContain(
      `${profile.id}:${res.id}`
    );

    // A re-save (finish→edit→re-finish) RE-arms the same key — one timer, not two.
    const again = await saveActivity(
      fd({
        id: String(res.id),
        type: "cardio",
        title: "Evening run",
        date: today(profile.id),
        start_time: "18:00",
        end_time: "18:50",
        components: cardio,
        sets: "[]",
      })
    );
    expect(again.ok).toBe(true);
    expect(
      pendingPostWorkoutDispatchKeys().filter(
        (k) => k === `${profile.id}:${res.id}`
      )
    ).toHaveLength(1);
  });

  it("a PAST-dated save arms nothing", async () => {
    const login = createLogin();
    const profile = createProfile("pw-past", login.id);
    actAs(login, profile);

    const res = await saveActivity(
      fd({
        type: "cardio",
        title: "Old run",
        date: "2026-01-05",
        components: cardio,
        sets: "[]",
      })
    );
    expect(res.ok).toBe(true);
    if (!res.ok) throw new Error("unreachable");
    expect(pendingPostWorkoutDispatchKeys()).not.toContain(
      `${profile.id}:${res.id}`
    );
  });
});
