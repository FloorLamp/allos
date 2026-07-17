// Situation-aware coaching (issue #837): the pure hold decision + ease-back ramp.
// The engine holds the go-train / gap / pace nags during an open flagged-illness
// episode (and through the short ease-back ramp after it closes), keeps the rest +
// safety recommendations untouched, and emits a one-shot ease-back re-entry rec on
// close. These are the pure boundary pins; the DB-tier fixture (coaching-illness DB
// test) exercises the same behavior end-to-end through gatherCoachingInput.

import { describe, it, expect } from "vitest";
import {
  EASE_BACK_RAMP_DAYS,
  easeBackRecommendation,
  illnessCoachingMode,
  illnessHeldNote,
  recommendCoaching,
  type CoachingInput,
  type IllnessCoachingContext,
  type RoutineTargetProgress,
} from "@/lib/coaching";

const TODAY = "2026-07-08";

// A training context that normally yields a "go train" gap nag (an unmet weekly
// routine target), so the hold is observable as its ABSENCE.
function tgt(over: Partial<RoutineTargetProgress> = {}): RoutineTargetProgress {
  return {
    target: { id: 1, scope_kind: "type", scope_value: "strength" },
    count: 0,
    per_week: 3,
    met: false,
    ...over,
  };
}

function input(over: Partial<CoachingInput> = {}): CoachingInput {
  return {
    today: TODAY,
    routine: [tgt()],
    strength: [],
    cardio: [],
    trainingDates: ["2026-07-01"],
    sleep: null,
    restingHr: null,
    weightUnit: "kg",
    ...over,
  };
}

// A last night far below the absolute sleep floor → a rest recommendation fires.
const POOR_SLEEP = { lastNightMin: 240, baselineMin: 450 };

// Training-side (go-train / gap / pace) recommendation kinds — the ones held during
// an episode. Rest + the illness note are NOT in this set.
const GO_TRAIN = new Set(["strength", "cardio", "ontrack"]);

describe("illnessCoachingMode — the hold/ease-back decision (#837)", () => {
  it("returns normal when there is no illness context", () => {
    expect(illnessCoachingMode(null, TODAY)).toEqual({
      mode: "normal",
      easeBackEpisodeId: null,
    });
    expect(illnessCoachingMode(undefined, TODAY)).toEqual({
      mode: "normal",
      easeBackEpisodeId: null,
    });
  });

  it("holds while a flagged-illness episode is open", () => {
    const ctx: IllnessCoachingContext = { openEpisode: true, lastClosed: null };
    expect(illnessCoachingMode(ctx, TODAY)).toEqual({
      mode: "held",
      easeBackEpisodeId: null,
    });
  });

  it("an open episode wins over a recently-closed one (held, not ease-back)", () => {
    const ctx: IllnessCoachingContext = {
      openEpisode: true,
      lastClosed: { episodeId: 9, endDate: TODAY },
    };
    expect(illnessCoachingMode(ctx, TODAY).mode).toBe("held");
  });

  it("eases back on the close day and through the ramp window", () => {
    // Day 0 (close day = first well day), day 1, day 2 are all within the ramp.
    for (const [endDate, ago] of [
      [TODAY, 0],
      ["2026-07-07", 1],
      ["2026-07-06", 2],
    ] as const) {
      const ctx: IllnessCoachingContext = {
        openEpisode: false,
        lastClosed: { episodeId: 42, endDate },
      };
      expect(ago).toBeLessThan(EASE_BACK_RAMP_DAYS);
      expect(illnessCoachingMode(ctx, TODAY)).toEqual({
        mode: "ease-back",
        easeBackEpisodeId: 42,
      });
    }
  });

  it("resumes normal coaching once the ramp window has passed", () => {
    // ago === EASE_BACK_RAMP_DAYS (3) is the first day OUTSIDE the ramp.
    const ctx: IllnessCoachingContext = {
      openEpisode: false,
      lastClosed: { episodeId: 42, endDate: "2026-07-05" }, // 3 days ago
    };
    expect(illnessCoachingMode(ctx, TODAY).mode).toBe("normal");
  });

  it("ignores a future close date (never eases back before close)", () => {
    const ctx: IllnessCoachingContext = {
      openEpisode: false,
      lastClosed: { episodeId: 42, endDate: "2026-07-09" },
    };
    expect(illnessCoachingMode(ctx, TODAY).mode).toBe("normal");
  });
});

describe("recommendCoaching — the situation-aware hold (#837)", () => {
  it("fires the go-train gap nag normally (baseline)", () => {
    const recs = recommendCoaching(input());
    expect(recs.some((r) => GO_TRAIN.has(r.kind))).toBe(true);
    expect(recs.some((r) => r.kind === "illness")).toBe(false);
  });

  it("HOLDS the gap nags during an open episode, keeps the held note", () => {
    const recs = recommendCoaching(
      input({ illness: { openEpisode: true, lastClosed: null } })
    );
    // No go-train / gap / pace nag fires.
    expect(recs.some((r) => GO_TRAIN.has(r.kind))).toBe(false);
    // A calm held note explains the quiet, carrying the #656 reason.
    const held = recs.find((r) => r.id === "illness-hold");
    expect(held).toBeTruthy();
    expect(held!.reasons?.[0].code).toBe("coaching-held");
    expect(held!.reasons?.[0].text).toBe("Held — illness episode open");
  });

  it("keeps the rest recommendation untouched during an open episode", () => {
    const recs = recommendCoaching(
      input({
        sleep: POOR_SLEEP,
        illness: { openEpisode: true, lastClosed: null },
      })
    );
    // Rest still fires and leads (recovery/safety untouched); gap nags still held.
    expect(recs[0].kind).toBe("rest");
    expect(recs.some((r) => GO_TRAIN.has(r.kind))).toBe(false);
    expect(recs.some((r) => r.id === "illness-hold")).toBe(true);
  });

  it("emits the one-shot ease-back rec on close, still holding gap nags", () => {
    const recs = recommendCoaching(
      input({
        illness: {
          openEpisode: false,
          lastClosed: { episodeId: 7, endDate: TODAY },
        },
      })
    );
    expect(recs.some((r) => GO_TRAIN.has(r.kind))).toBe(false);
    const easeBack = recs.find((r) => r.id === "illness-ease-back");
    expect(easeBack).toBeTruthy();
    expect(easeBack!.detail).toBe(easeBackRecommendation().detail);
    // No lingering held note during ease-back — the ease-back replaces it.
    expect(recs.some((r) => r.id === "illness-hold")).toBe(false);
  });

  it("resumes the gap nags after the ramp window", () => {
    const recs = recommendCoaching(
      input({
        illness: {
          openEpisode: false,
          lastClosed: { episodeId: 7, endDate: "2026-07-05" }, // 3 days ago
        },
      })
    );
    expect(recs.some((r) => GO_TRAIN.has(r.kind))).toBe(true);
    expect(recs.some((r) => r.kind === "illness")).toBe(false);
  });

  it("the held note and ease-back rec are informational, never alarms", () => {
    expect(illnessHeldNote().tone).toBe("neutral");
    expect(easeBackRecommendation().tone).toBe("positive");
  });
});
