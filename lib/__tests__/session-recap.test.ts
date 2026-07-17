import { describe, it, expect } from "vitest";
import {
  sessionRecap,
  recapSessionFromPayload,
  recapSessionFromEditData,
  formatRecapLine,
  fmtRecapVolume,
  type RecapHistory,
  type RecapInputSession,
} from "../session-recap";
import type { ActivitySetPayload } from "../activity-form-validate";
import type { ActivityEditData } from "../activity-form-model";

// A weighted set payload (client path), display units = kg in these fixtures so
// the two-path pin has no unit-rounding drift.
function payloadSet(o: Partial<ActivitySetPayload>): ActivitySetPayload {
  return {
    exercise: "Bench press",
    weight: null,
    reps: null,
    weightRight: null,
    repsRight: null,
    durationSec: null,
    durationSecRight: null,
    equipmentId: null,
    targetReps: null,
    toFailure: false,
    warmup: false,
    rpe: null,
    ...o,
  };
}

function editSet(o: Partial<ActivityEditData["sets"][number]>) {
  return {
    exercise: "Bench press",
    set_number: 1,
    weight_kg: null,
    reps: null,
    weight_kg_right: null,
    reps_right: null,
    duration_sec: null,
    duration_sec_right: null,
    equipment_id: null,
    target_reps: null,
    to_failure: null,
    warmup: null,
    rpe: null,
    ...o,
  } as ActivityEditData["sets"][number];
}

function editData(sets: ActivityEditData["sets"]): ActivityEditData {
  return {
    id: 1,
    type: "strength",
    title: "Push day",
    date: "2026-07-17",
    duration_min: 47,
    distance_km: null,
    intensity: "hard",
    start_time: "17:00",
    end_time: "17:47",
    components: null,
    notes: null,
    sets,
  };
}

const NO_HISTORY: RecapHistory = {};

describe("sessionRecap — target rollup", () => {
  it("all-hit when every targeted set met its target", () => {
    const s: RecapInputSession = {
      title: "Push day",
      durationMin: 40,
      intensity: null,
      bodyweightKg: 0,
      exercises: [
        {
          exercise: "Bench press",
          sets: [
            { weightKg: 60, reps: 5, targetReps: 5 },
            { weightKg: 60, reps: 6, targetReps: 5 },
          ],
        },
      ],
    };
    const r = sessionRecap(s, NO_HISTORY);
    expect(r.targetRollup).toBe("all-hit");
    expect(r.exercises[0].verdict).toBe("met");
  });

  it("some-missed when any targeted set fell short", () => {
    const r = sessionRecap(
      {
        title: "Push day",
        durationMin: 40,
        intensity: null,
        bodyweightKg: 0,
        exercises: [
          {
            exercise: "Bench press",
            sets: [
              { weightKg: 60, reps: 5, targetReps: 5 },
              { weightKg: 60, reps: 3, targetReps: 5 },
            ],
          },
        ],
      },
      NO_HISTORY
    );
    expect(r.targetRollup).toBe("some-missed");
    expect(r.exercises[0].verdict).toBe("missed");
  });

  it("to-failure and untargeted sets are NEVER a miss (judgeTargets exemption)", () => {
    const r = sessionRecap(
      {
        title: "Push day",
        durationMin: 40,
        intensity: null,
        bodyweightKg: 0,
        exercises: [
          {
            // AMRAP set below any implied target — not a miss.
            exercise: "Bench press",
            sets: [{ weightKg: 60, reps: 2, targetReps: 8, toFailure: true }],
          },
          {
            // No target declared — not a miss, contributes to none-targeted.
            exercise: "Overhead press",
            sets: [{ weightKg: 40, reps: 3 }],
          },
        ],
      },
      NO_HISTORY
    );
    expect(r.exercises[0].verdict).toBeNull();
    expect(r.exercises[1].verdict).toBeNull();
    expect(r.targetRollup).toBe("none-targeted");
  });
});

describe("sessionRecap — working sets & volume", () => {
  it("counts non-warmup working sets and sums working volume (kg), excluding warmups", () => {
    const r = sessionRecap(
      {
        title: "Push day",
        durationMin: 47,
        intensity: "hard",
        bodyweightKg: 0,
        exercises: [
          {
            exercise: "Bench press",
            sets: [
              { weightKg: 40, reps: 8, warmup: true }, // excluded from both
              { weightKg: 60, reps: 5 },
              { weightKg: 60, reps: 5 },
            ],
          },
        ],
      },
      NO_HISTORY
    );
    expect(r.totalWorkingSets).toBe(2);
    expect(r.totalVolumeKg).toBe(600); // 60*5 + 60*5
    expect(r.exercises[0].workingSets).toBe(2);
    expect(r.exercises[0].volumeKg).toBe(600);
  });
});

describe("sessionRecap — PR flags (lastSessionPR semantics)", () => {
  const priorHistory: RecapHistory = {
    "bench press": {
      bodyweight: false,
      sessions: [
        {
          activityId: 10,
          date: "2026-07-10",
          exercise: "Bench press",
          baseKg: 0,
          sets: [
            {
              weight_kg: 60,
              reps: 5,
              weight_kg_right: null,
              reps_right: null,
            },
          ],
        },
      ],
    },
  };

  it("flags an e1RM PR and a weight PR when this session beats all prior", () => {
    const r = sessionRecap(
      {
        title: "Push day",
        durationMin: 40,
        intensity: null,
        bodyweightKg: 0,
        exercises: [
          { exercise: "Bench press", sets: [{ weightKg: 65, reps: 5 }] },
        ],
      },
      priorHistory,
      { currentActivityId: 99 }
    );
    expect(r.exercises[0].e1rmPR).toBe(true);
    expect(r.exercises[0].weightPR).toBe(true);
    expect(r.prExercises).toEqual(["Bench press"]);
  });

  it("no PR on a first-ever session (no prior history — not established)", () => {
    const r = sessionRecap(
      {
        title: "Push day",
        durationMin: 40,
        intensity: null,
        bodyweightKg: 0,
        exercises: [
          { exercise: "Bench press", sets: [{ weightKg: 100, reps: 5 }] },
        ],
      },
      NO_HISTORY
    );
    expect(r.exercises[0].e1rmPR).toBe(false);
    expect(r.exercises[0].weightPR).toBe(false);
    expect(r.prExercises).toEqual([]);
  });

  it("excludes the current session from its own history (server path re-observation)", () => {
    // The just-finished session is already in the map under activityId 10; only
    // prior OTHER sessions count. Here there is no other prior, so no PR.
    const r = sessionRecap(
      {
        title: "Push day",
        durationMin: 40,
        intensity: null,
        bodyweightKg: 0,
        exercises: [
          { exercise: "Bench press", sets: [{ weightKg: 65, reps: 5 }] },
        ],
      },
      priorHistory,
      { currentActivityId: 10 }
    );
    expect(r.exercises[0].e1rmPR).toBe(false);
  });

  it("suppresses the weight PR for a bodyweight lift", () => {
    const history: RecapHistory = {
      "pull-up": {
        bodyweight: true,
        sessions: [
          {
            activityId: 5,
            date: "2026-07-10",
            exercise: "Pull-up",
            baseKg: 80,
            sets: [
              { weight_kg: 0, reps: 8, weight_kg_right: null, reps_right: null },
            ],
          },
        ],
      },
    };
    const r = sessionRecap(
      {
        title: "Pull day",
        durationMin: 30,
        intensity: null,
        bodyweightKg: 80,
        exercises: [{ exercise: "Pull-up", sets: [{ weightKg: 0, reps: 12 }] }],
      },
      history,
      { currentActivityId: 99 }
    );
    expect(r.exercises[0].e1rmPR).toBe(true); // more reps at bodyweight = e1RM PR
    expect(r.exercises[0].weightPR).toBe(false); // never a weight PR for bodyweight
  });
});

describe("sessionRecap — vs-last delta", () => {
  it("computes the e1RM delta against the previous session (implement-appropriate seed)", () => {
    const history: RecapHistory = {
      "bench press": {
        bodyweight: false,
        sessions: [
          {
            activityId: 10,
            date: "2026-07-10",
            exercise: "Bench press",
            baseKg: 0,
            sets: [
              { weight_kg: 60, reps: 5, weight_kg_right: null, reps_right: null },
            ],
          },
        ],
      },
    };
    const r = sessionRecap(
      {
        title: "Push day",
        durationMin: 40,
        intensity: null,
        bodyweightKg: 0,
        exercises: [
          { exercise: "Bench press", sets: [{ weightKg: 65, reps: 5 }] },
        ],
      },
      history,
      { currentActivityId: 99 }
    );
    // 65*(1+5/30) - 60*(1+5/30) = 5*(7/6) = 5.833… -> 5.8
    expect(r.exercises[0].deltaE1rmKg).toBeCloseTo(5.8, 1);
  });

  it("null delta when there is no prior session", () => {
    const r = sessionRecap(
      {
        title: "Push day",
        durationMin: 40,
        intensity: null,
        bodyweightKg: 0,
        exercises: [
          { exercise: "Bench press", sets: [{ weightKg: 65, reps: 5 }] },
        ],
      },
      NO_HISTORY
    );
    expect(r.exercises[0].deltaE1rmKg).toBeNull();
  });
});

describe("sessionRecap — RPE aggregation", () => {
  it("averages logged working-set RPE, ignoring warmups and unlogged sets", () => {
    const r = sessionRecap(
      {
        title: "Push day",
        durationMin: 40,
        intensity: null,
        bodyweightKg: 0,
        exercises: [
          {
            exercise: "Bench press",
            sets: [
              { weightKg: 40, reps: 8, warmup: true, rpe: 4 }, // warmup ignored
              { weightKg: 60, reps: 5, rpe: 8 },
              { weightKg: 60, reps: 5, rpe: 9 },
              { weightKg: 60, reps: 5 }, // unlogged, ignored
            ],
          },
        ],
      },
      NO_HISTORY
    );
    expect(r.avgRpe).toBe(8.5);
  });

  it("null when no RPE was logged", () => {
    const r = sessionRecap(
      {
        title: "Push day",
        durationMin: 40,
        intensity: null,
        bodyweightKg: 0,
        exercises: [{ exercise: "Bench press", sets: [{ weightKg: 60, reps: 5 }] }],
      },
      NO_HISTORY
    );
    expect(r.avgRpe).toBeNull();
  });
});

describe("two input paths yield the same recap (#221 no-drift)", () => {
  const history: RecapHistory = {
    "bench press": {
      bodyweight: false,
      sessions: [
        {
          activityId: 10,
          date: "2026-07-10",
          exercise: "Bench press",
          baseKg: 0,
          sets: [
            { weight_kg: 60, reps: 5, weight_kg_right: null, reps_right: null },
          ],
        },
      ],
    },
    "overhead press": {
      bodyweight: false,
      sessions: [
        {
          activityId: 10,
          date: "2026-07-10",
          exercise: "Overhead press",
          baseKg: 0,
          sets: [
            { weight_kg: 40, reps: 6, weight_kg_right: null, reps_right: null },
          ],
        },
      ],
    },
  };

  it("client payload path === server edit-data path", () => {
    // The SAME session, expressed both ways: 1 warmup + 2 working bench sets
    // (target 5), 1 overhead working set. Weights in kg on both sides so no
    // unit-rounding difference can creep in.
    const flat: ActivitySetPayload[] = [
      payloadSet({ exercise: "Bench press", weight: 40, reps: 8, warmup: true }),
      payloadSet({ exercise: "Bench press", weight: 65, reps: 5, targetReps: 5, rpe: 8 }),
      payloadSet({ exercise: "Bench press", weight: 65, reps: 6, targetReps: 5, rpe: 9 }),
      payloadSet({ exercise: "Overhead press", weight: 42.5, reps: 6 }),
    ];
    const clientSession = recapSessionFromPayload(
      flat,
      {
        title: "Push day",
        durationMin: 47,
        intensity: "hard",
        bodyweightKg: 0,
      },
      "kg"
    );

    const serverSession = recapSessionFromEditData(
      editData([
        editSet({ exercise: "Bench press", set_number: 1, weight_kg: 40, reps: 8, warmup: 1 }),
        editSet({ exercise: "Bench press", set_number: 2, weight_kg: 65, reps: 5, target_reps: 5, rpe: 8 }),
        editSet({ exercise: "Bench press", set_number: 3, weight_kg: 65, reps: 6, target_reps: 5, rpe: 9 }),
        editSet({ exercise: "Overhead press", set_number: 4, weight_kg: 42.5, reps: 6 }),
      ]),
      { bodyweightKg: 0 }
    );

    const clientRecap = sessionRecap(clientSession, history, {
      currentActivityId: 99,
    });
    const serverRecap = sessionRecap(serverSession, history, {
      currentActivityId: 99,
    });
    expect(clientRecap).toEqual(serverRecap);

    // And it's a meaningful recap (not two empty objects matching trivially).
    expect(serverRecap.totalWorkingSets).toBe(3);
    expect(serverRecap.exercises[0].e1rmPR).toBe(true);
    expect(serverRecap.targetRollup).toBe("all-hit");
    expect(serverRecap.avgRpe).toBe(8.5);
  });
});

describe("formatRecapLine", () => {
  it("leads with the session, then duration/sets/PR/targets", () => {
    const r = sessionRecap(
      {
        title: "Push day",
        durationMin: 47,
        intensity: "hard",
        bodyweightKg: 0,
        exercises: [
          {
            exercise: "Bench press",
            sets: [
              { weightKg: 65, reps: 5, targetReps: 5 },
              { weightKg: 65, reps: 6, targetReps: 5 },
            ],
          },
        ],
      },
      {
        "bench press": {
          bodyweight: false,
          sessions: [
            {
              activityId: 10,
              date: "2026-07-10",
              exercise: "Bench press",
              baseKg: 0,
              sets: [
                { weight_kg: 60, reps: 5, weight_kg_right: null, reps_right: null },
              ],
            },
          ],
        },
      },
      { currentActivityId: 99 }
    );
    expect(formatRecapLine(r)).toBe(
      "Push day done · 47 min · 2 sets · Bench press PR · all targets hit"
    );
  });

  it("drops empty segments (untargeted, no PR, no duration)", () => {
    const r = sessionRecap(
      {
        title: "Quick lift",
        durationMin: null,
        intensity: null,
        bodyweightKg: 0,
        exercises: [{ exercise: "Bench press", sets: [{ weightKg: 60, reps: 5 }] }],
      },
      NO_HISTORY
    );
    expect(formatRecapLine(r)).toBe("Quick lift done · 1 set");
  });

  it("summarizes multiple PRs as a count", () => {
    const history: RecapHistory = {
      "bench press": {
        bodyweight: false,
        sessions: [
          {
            activityId: 10,
            date: "2026-07-10",
            exercise: "Bench press",
            baseKg: 0,
            sets: [{ weight_kg: 60, reps: 5, weight_kg_right: null, reps_right: null }],
          },
        ],
      },
      "squat": {
        bodyweight: false,
        sessions: [
          {
            activityId: 10,
            date: "2026-07-10",
            exercise: "Squat",
            baseKg: 0,
            sets: [{ weight_kg: 100, reps: 5, weight_kg_right: null, reps_right: null }],
          },
        ],
      },
    };
    const r = sessionRecap(
      {
        title: "Full body",
        durationMin: 60,
        intensity: null,
        bodyweightKg: 0,
        exercises: [
          { exercise: "Bench press", sets: [{ weightKg: 70, reps: 5 }] },
          { exercise: "Squat", sets: [{ weightKg: 110, reps: 5 }] },
        ],
      },
      history,
      { currentActivityId: 99 }
    );
    expect(formatRecapLine(r)).toContain("2 PRs");
  });
});

describe("fmtRecapVolume", () => {
  it("rounds and thousands-groups in the login unit", () => {
    expect(fmtRecapVolume(2450, "kg")).toBe("2,450 kg");
    expect(fmtRecapVolume(1000, "lb")).toBe("2,205 lb");
  });
});
