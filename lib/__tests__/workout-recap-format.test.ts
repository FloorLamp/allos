import { describe, it, expect } from "vitest";
import { plainBody } from "@/lib/notifications/rich-text";
import {
  ACTIVITY_TYPE_ASK_PROMPT,
  activityTypeAskActions,
  composeFinishNudge,
  finishNudgeTitle,
  importedRecapLine,
  recapNudgeLine,
  weeklyRemainingLine,
  type ImportedSessionFacts,
} from "../notifications/workout-recap-format";
import type { NotificationMessage } from "../notifications/types";
import type { Recap } from "../session-recap";
import { ACTIVITY_TYPES } from "@/lib/types";
import type { SessionCadenceFacts } from "@/lib/cadence";

function recap(over: Partial<Recap> = {}): Recap {
  return {
    title: "Push day",
    durationMin: 47,
    intensity: "hard",
    exercises: [],
    totalWorkingSets: 14,
    totalVolumeKg: 2450,
    targetRollup: "all-hit",
    prExercises: ["Bench press"],
    avgRpe: 8,
    ...over,
  };
}

const doseMsg: NotificationMessage = {
  title: "🏋️ Post-workout — 1 dose",
  body: "• Creatine — 5 g",
  actions: [
    { label: "✅ Creatine", data: "take:1:2:3:2026-07-17", row: "dose:2" },
  ],
  kind: "dose",
};

describe("recapNudgeLine", () => {
  it("returns the DETAILED recap line — the chat has no card under it (#2172)", () => {
    // The bare set count is gone from the chat form: a PR (or, without one, the best
    // vs-last delta) takes that slot, because the message's existence already says the
    // session happened. The compact form is pinned in session-recap.test.ts.
    expect(recapNudgeLine(recap(), true)).toBe(
      "Push day done · 47 min · Bench press PR · all targets hit"
    );
  });

  it("names and quantifies a miss the compact form would have collapsed (#2172)", () => {
    const line = recapNudgeLine(
      recap({
        prExercises: [],
        targetRollup: "some-missed",
        exercises: [
          {
            exercise: "Lat Pulldown",
            workingSets: 4,
            volumeKg: 1500,
            verdict: "missed",
            bodyweight: false,
            e1rmPR: false,
            weightPR: false,
            deltaE1rmKg: null,
            missedSets: 1,
            shortfall: { reps: 7, target: 8 },
          },
        ],
      }),
      true
    );
    expect(line).toBe("Push day done · 47 min · Lat Pulldown 7/8 on one set");
  });

  it("returns null when the toggle is off (kind disabled strips it)", () => {
    expect(recapNudgeLine(recap(), false)).toBeNull();
  });

  it("returns null for a finish with no strength working sets (pure cardio)", () => {
    expect(
      recapNudgeLine(recap({ totalWorkingSets: 0, prExercises: [] }), true)
    ).toBeNull();
  });

  it("returns null when there's no recap", () => {
    expect(recapNudgeLine(null, true)).toBeNull();
  });
});

describe("composeFinishNudge", () => {
  it("leads with the recap line, then the supplement section", () => {
    const line = recapNudgeLine(recap(), true);
    const msg = composeFinishNudge(line, doseMsg);
    expect(msg).not.toBeNull();
    expect(plainBody(msg!.body).startsWith("Push day done ·")).toBe(true);
    expect(msg!.body).toContain("Creatine");
    // Dose section still leads the message content after the recap line.
    expect(msg!.body).toBe(`${line}\n\n${doseMsg.body}`);
    // Keeps the dose message's SAFETY-tier kind + actions.
    expect(msg!.kind).toBe("dose");
    expect(msg!.actions).toEqual(doseMsg.actions);
  });

  it("strips the recap line when the toggle is disabled — dose message unchanged", () => {
    const line = recapNudgeLine(recap(), false); // null
    const msg = composeFinishNudge(line, doseMsg);
    expect(msg).toEqual(doseMsg);
  });

  it("sends recap-only (no due doses) as a workout-recap message", () => {
    const line = recapNudgeLine(recap(), true);
    const msg = composeFinishNudge(line, null);
    expect(msg).not.toBeNull();
    expect(msg!.kind).toBe("workout-recap");
    expect(msg!.body).toBe(line);
    expect(msg!.actions).toBeUndefined();
  });

  it("both absent ⇒ no send", () => {
    expect(composeFinishNudge(null, null)).toBeNull();
  });
});

// #2503: the title was one hardcoded "🏋️ Workout complete" from the days when only a
// manual strength session could produce a recap line. #2272 opened the message to every
// import and the barbell came with it — a 1.42 km walk arrived announced as a workout.
describe("finishNudgeTitle (#2503)", () => {
  it("names what actually finished, per discipline", () => {
    expect(finishNudgeTitle("strength")).toBe("🏋️ Workout complete");
    expect(finishNudgeTitle("cardio")).toBe("🏃 Cardio complete");
    expect(finishNudgeTitle("sport")).toBe("⚽ Sport complete");
  });

  it("gives every named discipline its own face", () => {
    // The leading glyph (everything before the first space, so a variation selector
    // travels with its base) is distinct per named discipline — one shared face would
    // put #2503 back on a different pair.
    const named = ["strength", "cardio", "sport", "recovery"] as const;
    const faces = named.map((t) => finishNudgeTitle(t).split(" ")[0]);
    expect(new Set(faces).size).toBe(named.length);
  });

  it("claims no discipline for the stated absence, or for an unreadable row", () => {
    // `unclassified` means the SOURCE did not say (#2272): the message is carrying the
    // ask that fixes it, so its own title must not answer the question first. The glyph
    // is the vocabulary's declared GENERIC training marker, not the strength one — the
    // per-discipline faces are what name a discipline.
    expect(finishNudgeTitle("unclassified")).toBe("🏋️ Session complete");
    expect(finishNudgeTitle("unclassified")).not.toMatch(
      /workout|cardio|sport/i
    );
    expect(finishNudgeTitle(null)).toBe(finishNudgeTitle("unclassified"));
  });

  it("does not call a mobility session a workout (#840)", () => {
    // Its own face, not the training marker: announcing mobility work under a barbell
    // tells a person it counted as training load (#482, trained ≠ mobilized).
    expect(finishNudgeTitle("recovery")).toBe("🤸 Mobility complete");
    expect(finishNudgeTitle("recovery")).not.toMatch(/workout/i);
    expect(finishNudgeTitle("recovery")).not.toContain("🏋️");
  });

  it("answers for every declared type", () => {
    // The per-type map is an exhaustive Record, so tsc is the real guard; this pins
    // that no member was quieted with an empty placeholder.
    for (const t of ACTIVITY_TYPES)
      expect(finishNudgeTitle(t).trim().length).toBeGreaterThan(2);
  });

  it("titles the recap-only message by the finishing row's type", () => {
    const msg = composeFinishNudge(
      "Afternoon Walk done · 33 min · 1.42 km",
      null,
      null,
      "cardio"
    );
    expect(msg!.title).toBe("🏃 Cardio complete");
  });

  it("leaves the dose message's own title alone — it names the dose condition", () => {
    // A combined message keeps the SAFETY-tier dose title and kind: "Post-workout" there
    // is the name of the dose's `condition`, not a claim about the session.
    const msg = composeFinishNudge(
      "Afternoon Walk done · 33 min",
      doseMsg,
      null,
      "cardio"
    );
    expect(msg!.title).toBe(doseMsg.title);
  });
});

// A minimal FrequencyTargetProgress-shaped fixture for the workout-scoped recap line.
function target(
  scope_kind: string,
  scope_value: string,
  count: number,
  per_week: number
) {
  return {
    target: { scope_kind, scope_value },
    count,
    per_week,
    met: count >= per_week,
  };
}

// What the finishing session itself put on the board (#2503). The default is the
// strength session the older cases were written against: a Bench Press day, which the
// exercise→region rollup lands on Chest.
function session(over: Partial<SessionCadenceFacts> = {}): SessionCadenceFacts {
  return { types: ["strength"], regions: ["Chest"], ...over };
}

// The walk from the report: a `cardio` row with no sets, so no region anywhere.
const WALK = session({ types: ["cardio"], regions: [] });

describe("weeklyRemainingLine (#981 §3, #1122, #2503)", () => {
  it("leads with the in-progress workout target, pace-framed (count 1 / per_week 2)", () => {
    // The issue's example: a `region` (Legs) target the session just advanced.
    expect(
      weeklyRemainingLine(
        [target("region", "Legs", 1, 2)],
        session({ regions: ["Legs"] })
      )
    ).toBe("Legs — 1 of 2 this week, one more to go.");
  });

  it("pluralizes the tail when more than one session remains", () => {
    expect(weeklyRemainingLine([target("type", "cardio", 1, 3)], WALK)).toBe(
      "Cardio — 1 of 3 this week, 2 more to go."
    );
  });

  it("excludes food_group targets from a WORKOUT recap (#1122 defect 1)", () => {
    // A lifting session can't advance veg-servings; grading it here is the "0 of N" bug.
    // With only a food_group target present, the workout recap has nothing to say.
    expect(
      weeklyRemainingLine([target("food_group", "vegetables", 0, 5)], session())
    ).toBeNull();
  });

  it("excludes mobility_region targets too, and leads with the workout one", () => {
    // food_group + mobility_region are dropped; the in-progress `region` leads.
    expect(
      weeklyRemainingLine(
        [
          target("food_group", "vegetables", 0, 5),
          target("mobility_region", "Legs", 0, 3),
          target("region", "Chest", 1, 2),
        ],
        session()
      )
    ).toBe("Chest — 1 of 2 this week, one more to go.");
  });

  it("leads with the closest-to-done in-progress target the session advanced", () => {
    // Lower body needs 1 more (2 of 3), Cardio needs 2 more (1 of 3) → lead with Lower.
    expect(
      weeklyRemainingLine(
        [target("type", "cardio", 1, 3), target("group", "Lower", 2, 3)],
        // A leg day: `group` Lower is the union of Legs + Glutes.
        session({ regions: ["Legs"] })
      )
    ).toBe("Lower body — 2 of 3 this week, one more to go.");
  });

  it("all workout targets met ⇒ a calm celebratory-neutral line", () => {
    expect(
      weeklyRemainingLine(
        [target("region", "Legs", 2, 2), target("type", "cardio", 3, 3)],
        session({ regions: ["Legs"] })
      )
    ).toBe("All weekly targets met — nice work.");
  });

  it("no workout targets at all ⇒ omitted (null)", () => {
    expect(weeklyRemainingLine([], session())).toBeNull();
    expect(
      weeklyRemainingLine([target("mobility_region", "Legs", 0, 3)], session())
    ).toBeNull();
  });

  it("nothing advanced and nothing met ⇒ stays quiet (no misleading '0 of N')", () => {
    // Targets exist but this session didn't advance any (all count 0) — don't tally them.
    expect(
      weeklyRemainingLine(
        [target("region", "Legs", 0, 2), target("type", "cardio", 0, 3)],
        session({ regions: ["Legs"] })
      )
    ).toBeNull();
  });
});

// The defect in the report: the rollup is profile-wide, so before #2503 the line led
// with the closest-to-done target ANYWHERE — a chest target a barbell session had
// advanced earlier in the week, printed under "Afternoon Walk done · 33 min · 1.42 km" and
// tailed with a nudge toward a chest day the walk had nothing to do with.
describe("the weekly line is about THIS session (#2503)", () => {
  it("does not credit a walk with the chest day it did not do", () => {
    expect(
      weeklyRemainingLine([target("region", "Chest", 1, 2)], WALK)
    ).toBeNull();
  });

  it("still speaks for the target the walk DID advance", () => {
    // Same walk, same week: the cardio target it actually moved leads, and the chest
    // target it did not touch stays out of the message entirely.
    expect(
      weeklyRemainingLine(
        [target("region", "Chest", 1, 2), target("type", "cardio", 1, 3)],
        WALK
      )
    ).toBe("Cardio — 1 of 3 this week, 2 more to go.");
  });

  it("reads a component's type, the way the ledger counts one", () => {
    // A multi-part session counts for each component type it logged (cadenceCounts),
    // so a strength row with a cardio finisher advances the cardio target too.
    expect(
      weeklyRemainingLine(
        [target("type", "cardio", 2, 4)],
        session({ types: ["strength", "cardio"] })
      )
    ).toBe("Cardio — 2 of 4 this week, 2 more to go.");
  });

  it("stays quiet on an all-met week the session had no part in", () => {
    // "All weekly targets met" is true of the week, but a session that advanced none of
    // them has not earned the congratulation — and saying it here would read as one.
    expect(
      weeklyRemainingLine(
        [target("region", "Legs", 2, 2), target("type", "strength", 3, 3)],
        WALK
      )
    ).toBeNull();
  });
});

// ── The IMPORTED recap line and the type ask (#2272) ────────────────────────────

function facts(over: Partial<ImportedSessionFacts> = {}): ImportedSessionFacts {
  return {
    title: "Afternoon Workout",
    durationMin: 60,
    distanceKm: null,
    avgHr: null,
    maxHr: null,
    relativeEffort: null,
    ...over,
  };
}

describe("importedRecapLine (#2272)", () => {
  it("speaks the facts the import actually carries — and no volume/PR language", () => {
    const line = importedRecapLine(
      facts({ avgHr: 142.4, maxHr: 157, relativeEffort: 64 })
    );
    expect(line).toBe(
      "Afternoon Workout done · 60 min · avg HR 142 (max 157) · effort 64"
    );
    // The strength vocabulary must not appear for a row with no sets at all.
    expect(line).not.toMatch(/set|volume|PR|target/i);
  });

  it("includes distance in canonical km (the notification unit policy)", () => {
    expect(importedRecapLine(facts({ distanceKm: 8.234 }))).toBe(
      "Afternoon Workout done · 60 min · 8.23 km"
    );
  });

  it("falls back to the elapsed span only through its caller, and skips absent facts", () => {
    expect(importedRecapLine(facts({ durationMin: null, avgHr: 118 }))).toBe(
      "Afternoon Workout done · avg HR 118"
    );
    expect(importedRecapLine(facts({ avgHr: null, maxHr: 168 }))).toBe(
      "Afternoon Workout done · 60 min · max HR 168"
    );
  });

  it("is null when the import carries no fact beyond its own existence", () => {
    // "Workout done" alone is not worth a push.
    expect(importedRecapLine(facts({ durationMin: null }))).toBeNull();
    expect(importedRecapLine(facts({ durationMin: 0 }))).toBeNull();
  });

  it("names the session Workout when the import supplied no title", () => {
    expect(importedRecapLine(facts({ title: "  " }))).toBe(
      "Workout done · 60 min"
    );
  });
});

describe("the type ask rides an existing message (#2272)", () => {
  const ask = {
    prompt: ACTIVITY_TYPE_ASK_PROMPT,
    actions: activityTypeAskActions(1, 384),
  };

  it("mints three id-only tokens on one keyboard row", () => {
    expect(ask.actions.map((a) => a.data)).toEqual([
      "actype:1:384:strength",
      "actype:1:384:cardio",
      "actype:1:384:sport",
    ]);
    expect(new Set(ask.actions.map((a) => a.row))).toEqual(new Set(["actype"]));
  });

  it("adds a line and buttons to a recap-only message — never a send of its own", () => {
    const msg = composeFinishNudge(
      "Afternoon Workout done · 60 min",
      null,
      ask
    );
    expect(msg).not.toBeNull();
    expect(plainBody(msg!.body)).toBe(
      `Afternoon Workout done · 60 min\n\n${ACTIVITY_TYPE_ASK_PROMPT}`
    );
    expect(msg!.actions).toHaveLength(3);
    expect(msg!.kind).toBe("workout-recap");
  });

  it("appends to a dose message without displacing its own buttons or kind", () => {
    const msg = composeFinishNudge("Workout done · 60 min", doseMsg, ask);
    expect(msg!.kind).toBe("dose");
    expect(plainBody(msg!.body)).toContain(ACTIVITY_TYPE_ASK_PROMPT);
    expect(msg!.actions!.map((a) => a.data)).toEqual([
      "take:1:2:3:2026-07-17",
      "actype:1:384:strength",
      "actype:1:384:cardio",
      "actype:1:384:sport",
    ]);
  });

  it("has nothing to ride when neither a recap nor a dose section exists", () => {
    // The contact-consent rule: the system may reduce contact unilaterally, never
    // increase it. No message ⇒ no ask.
    expect(composeFinishNudge(null, null, ask)).toBeNull();
  });

  it("leaves the message untouched when there is no ask", () => {
    expect(composeFinishNudge("Workout done", doseMsg)!.actions).toEqual(
      doseMsg.actions
    );
  });
});
