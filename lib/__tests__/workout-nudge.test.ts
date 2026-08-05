import { describe, expect, it } from "vitest";
import {
  orderBehindTargets,
  recommendNextWorkout,
  isWorkoutTargetScope,
  WORKOUT_TARGET_SCOPES,
  type BehindTarget,
} from "@/lib/workout-recommendation";
import {
  behindThisWeekLine,
  cardioSessionLine,
  digestWorkoutLine,
  formatWorkoutReminder,
  type WorkoutRecommendation,
} from "@/lib/notifications/workout-format";
import { plainBody } from "@/lib/notifications/rich-text";
import { renderBodyHtml } from "@/lib/notifications/telegram-render";
import {
  trainingSignalKey,
  isWorkoutNudgeSuppressed,
} from "@/lib/workout-nudge";
import { FREQUENCY_SCOPE_KINDS } from "@/lib/goals";
import { TYPE_SCOPES } from "@/lib/lifts";
import type {
  CardioRecent,
  RoutineTargetProgress,
  StrengthRecent,
} from "@/lib/coaching";
import type { SuppressionRecord } from "@/lib/upcoming-suppress";

const TODAY = "2026-07-08";

function suppressions(
  entries: [string, SuppressionRecord][]
): Map<string, SuppressionRecord> {
  return new Map(entries);
}

const dismissed: SuppressionRecord = {
  dismissed_at: "2026-07-01",
  snooze_until: null,
};

describe("trainingSignalKey (#245 shared signal key)", () => {
  it("is the identical `training:<id>` string the Upcoming finding carries", () => {
    // The Upcoming training item keys itself `training:${p.target.id}` — the push
    // must derive the SAME string so a page dismissal lines up with the nudge.
    expect(trainingSignalKey(7)).toBe("training:7");
  });
});

describe("isWorkoutNudgeSuppressed (#245 bus gating)", () => {
  it("does NOT gate a nudge with no behind targets (habit/rest/on-track)", () => {
    // No `training:<id>` finding to line up with → the bus never touches it.
    expect(isWorkoutNudgeSuppressed([], suppressions([]), TODAY)).toBe(false);
  });

  it("ignores id-less targets (test fixtures) → not suppressed", () => {
    expect(
      isWorkoutNudgeSuppressed([null, null], suppressions([]), TODAY)
    ).toBe(false);
  });

  it("suppresses when the sole behind target's finding is dismissed", () => {
    expect(
      isWorkoutNudgeSuppressed(
        [7],
        suppressions([[trainingSignalKey(7), dismissed]]),
        TODAY
      )
    ).toBe(true);
  });

  it("still sends when the behind target's finding is not dismissed", () => {
    expect(isWorkoutNudgeSuppressed([7], suppressions([]), TODAY)).toBe(false);
  });

  it("still sends on PARTIAL suppression — one live target keeps the nudge on", () => {
    // 7 dismissed, 9 still live → not suppressed; the nudge fires for 9.
    expect(
      isWorkoutNudgeSuppressed(
        [7, 9],
        suppressions([[trainingSignalKey(7), dismissed]]),
        TODAY
      )
    ).toBe(false);
  });

  it("suppresses only when EVERY behind target is dismissed", () => {
    expect(
      isWorkoutNudgeSuppressed(
        [7, 9],
        suppressions([
          [trainingSignalKey(7), dismissed],
          [trainingSignalKey(9), dismissed],
        ]),
        TODAY
      )
    ).toBe(true);
  });

  it("treats an expired snooze as not suppressing (finding reappears)", () => {
    const snoozedPast: SuppressionRecord = {
      dismissed_at: null,
      snooze_until: "2026-07-05", // before TODAY → expired
    };
    expect(
      isWorkoutNudgeSuppressed(
        [7],
        suppressions([[trainingSignalKey(7), snoozedPast]]),
        TODAY
      )
    ).toBe(false);
  });

  it("treats an active snooze as suppressing", () => {
    const snoozedFuture: SuppressionRecord = {
      dismissed_at: null,
      snooze_until: "2026-07-20", // after TODAY → still hidden
    };
    expect(
      isWorkoutNudgeSuppressed(
        [7],
        suppressions([[trainingSignalKey(7), snoozedFuture]]),
        TODAY
      )
    ).toBe(true);
  });
});

// ---- "Behind this week" explains the suggestion (issue #1709) ----
//
// The reported message recommended Back and then listed Chest first: `behind` was
// flattened to opaque strings at the top of the pipeline, in routine-declaration order,
// so nothing connected the two halves and the target that actually drove the
// suggestion — the one at 0/2 — sat buried mid-line.
describe("behind-target ordering and marking (#1709)", () => {
  // `type` scope values are capitalized by frequencyScopeLabel; region values pass
  // through verbatim. Using type targets keeps the fixture readable AND exercises the
  // real label path.
  const t = (
    id: number,
    scopeValue: string,
    count: number,
    perWeek: number
  ): BehindTarget => ({
    id,
    scopeKind: "type",
    scopeValue,
    count,
    perWeek,
  });

  // The reported fixture, in its original routine-declaration order.
  const REPORTED = [
    t(1, "chest", 1, 2),
    t(2, "back", 0, 2),
    t(3, "cardio", 1, 2),
    t(4, "lower body", 1, 2),
  ];

  it("puts the driving target first, then the rest by deficit", () => {
    const ordered = orderBehindTargets(REPORTED, 2);
    expect(ordered.map((x) => x.scopeValue)).toEqual([
      "back", // the driver, 0/2
      "chest", // then deficit order; all three tie at 1, so routine order holds
      "cardio",
      "lower body",
    ]);
    expect(ordered[0].driving).toBe(true);
    expect(ordered.slice(1).every((x) => !x.driving)).toBe(true);
  });

  it("falls back to pure deficit order when no behind target drove the suggestion", () => {
    // The suggestion came from habit or variety — nothing is marked.
    const ordered = orderBehindTargets(REPORTED, null);
    expect(ordered.map((x) => x.scopeValue)).toEqual([
      "back", // biggest deficit (2), even unmarked
      "chest",
      "cardio",
      "lower body",
    ]);
    expect(ordered.every((x) => !x.driving)).toBe(true);
  });

  it("breaks equal deficits by routine order, for stability", () => {
    const ordered = orderBehindTargets(
      [t(1, "chest", 1, 2), t(2, "cardio", 1, 2), t(3, "back", 0, 3)],
      null
    );
    expect(ordered.map((x) => x.scopeValue)).toEqual([
      "back", // deficit 3
      "chest", // both deficit 1 → declaration order
      "cardio",
    ]);
  });

  it("marks a SINGLE behind target too — the connection is the point", () => {
    const ordered = orderBehindTargets([t(2, "back", 0, 2)], 2);
    expect(ordered[0].driving).toBe(true);
  });

  it("renders the driver first with the ← today marker, bold where supported", () => {
    const line = behindThisWeekLine(orderBehindTargets(REPORTED, 2))!;
    // Plain channels (Web Push / Home Assistant) get the suffix alone — the marker
    // survives without markup.
    expect(plainBody(line)).toBe(
      "Behind this week: Back 0/2 ← today, Chest 1/2, Cardio 1/2, Lower body 1/2"
    );
    // Telegram additionally bolds the driving item.
    expect(renderBodyHtml(line)).toContain("<b>Back 0/2 ← today</b>");
    expect(renderBodyHtml(line)).not.toContain("<b>Chest");
  });

  it("says nothing when nothing is behind", () => {
    expect(behindThisWeekLine([])).toBeNull();
  });

  // ---- #1822 item 3: the headline's own target is not restated ----
  //
  // "Trained today — Chest is 1/2 with only today left" followed two lines later by
  // "Behind this week: Chest 1/2 ← today" states one fact twice in a four-line message.
  // The AMENDMENT to the "suffix always" ruling (#1709) is exactly this narrow: the
  // target the headline already spelled out is dropped from the list. Nothing else moves.

  it("drops the target the headline already stated, keeping the rest marked", () => {
    const line = behindThisWeekLine(orderBehindTargets(REPORTED, 2), {
      scopeKind: "type",
      scopeValue: "back",
    })!;
    // "Back 0/2 ← today" is gone — it opened the message — and the others are intact.
    expect(plainBody(line)).toBe(
      "Behind this week: Chest 1/2, Cardio 1/2, Lower body 1/2"
    );
    expect(plainBody(line)).not.toContain("Back");
    expect(plainBody(line)).not.toContain("← today");
  });

  it("keeps the ← today suffix when the headline names a DIFFERENT target", () => {
    // The scoped amendment: the suffix survives on every message whose headline is not
    // the driver. Here the pace-tight target (chest) opened the message; the driver
    // (back) still leads the list with its marker.
    const line = behindThisWeekLine(orderBehindTargets(REPORTED, 2), {
      scopeKind: "type",
      scopeValue: "chest",
    })!;
    expect(plainBody(line)).toBe(
      "Behind this week: Back 0/2 ← today, Cardio 1/2, Lower body 1/2"
    );
    expect(renderBodyHtml(line)).toContain("<b>Back 0/2 ← today</b>");
  });

  it("falls away entirely when the headline's target was the only one behind", () => {
    expect(
      behindThisWeekLine(orderBehindTargets([t(2, "back", 0, 2)], 2), {
        scopeKind: "type",
        scopeValue: "back",
      })
    ).toBeNull();
  });

  it("is byte-for-byte the prior rendering with no headline subject", () => {
    const before = behindThisWeekLine(orderBehindTargets(REPORTED, 2))!;
    for (const stated of [undefined, null]) {
      expect(
        plainBody(behindThisWeekLine(orderBehindTargets(REPORTED, 2), stated)!)
      ).toBe(plainBody(before));
    }
    // A subject that is behind on nothing changes nothing either.
    expect(
      plainBody(
        behindThisWeekLine(orderBehindTargets(REPORTED, 2), {
          scopeKind: "type",
          scopeValue: "shoulders",
        })!
      )
    ).toBe(plainBody(before));
  });
});

// ---- The whole message, end to end (#1822 items 1–3) ----

describe("formatWorkoutReminder — the acknowledgment headline and its list", () => {
  const behind = orderBehindTargets(
    [
      { id: 1, scopeKind: "type", scopeValue: "chest", count: 1, perWeek: 2 },
      { id: 2, scopeKind: "type", scopeValue: "cardio", count: 1, perWeek: 2 },
    ],
    1
  );

  const rec = (
    over: Partial<WorkoutRecommendation> = {}
  ): WorkoutRecommendation => ({
    focus: ["Chest"],
    exercises: ["Barbell Bench Press"],
    behind,
    rest: null,
    onTrack: null,
    ...over,
  });

  it("states the driver ONCE and never as '0 days left'", () => {
    const msg = formatWorkoutReminder(
      rec({
        acknowledge: {
          session: "Workout",
          forcedBy: {
            scopeKind: "type",
            scopeValue: "chest",
            label: "Chest",
            count: 1,
            perWeek: 2,
            daysLeftInWindow: 0,
          },
        },
      })
    )!;
    const body = plainBody(msg.body);
    expect(body).toContain(
      "Trained today — Chest is 1/2 with only today left."
    );
    expect(body).not.toContain("0 days left");
    expect(body).not.toContain("Nice workout today");
    // The driver is stated once: the list carries only what the headline did not.
    expect(body).toContain("Behind this week: Cardio 1/2");
    // Named exactly once in the whole body — the redundancy is gone, not relabeled.
    expect(body.match(/Chest/g)).toHaveLength(1);
    expect(body).not.toContain("← today");
  });

  it("leaves a message with no acknowledgment headline untouched", () => {
    const body = plainBody(formatWorkoutReminder(rec())!.body);
    expect(body).toContain("Behind this week: Chest 1/2 ← today, Cardio 1/2");
  });
});

// ---- The digest's one-line workout preview (issue #1712 §2) ----
//
// The digest had no workout line at all, though recommendWorkout already computes one
// for the dedicated nudge slot. The preview formats the SAME recommendation, so a 7am
// heads-up and the actionable prompt later cannot disagree.
describe("digestWorkoutLine (#1712)", () => {
  const rec = (
    over: Partial<WorkoutRecommendation> = {}
  ): WorkoutRecommendation => ({
    focus: [],
    exercises: [],
    behind: [],
    rest: null,
    onTrack: null,
    ...over,
  });

  it("names the session and its lead exercises", () => {
    expect(
      digestWorkoutLine(
        rec({
          sessionLabel: "Back",
          exercises: ["Lat Pulldown", "Cable Row", "Deadlift", "Pull Up"],
        })
      )
    ).toBe("🏋️ Today: Back — Lat Pulldown, Cable Row, Deadlift");
  });

  it("reframes on a rest day instead of pushing", () => {
    expect(
      digestWorkoutLine(rec({ rest: { title: "Rest day", detail: "…" } }))
    ).toBe("🛌 Today: Rest day");
  });

  it("reframes when the week is already on track", () => {
    expect(
      digestWorkoutLine(
        rec({ onTrack: { title: "On track this week", detail: "…" } })
      )
    ).toBe("✅ Today: On track this week");
  });

  it("names a deload week so a lighter session reads as on-plan", () => {
    expect(
      digestWorkoutLine(
        rec({
          sessionLabel: "Push",
          exercises: ["Bench Press"],
          deloadWeek: true,
        })
      )
    ).toBe("🏋️ Today: Push — Bench Press (deload week)");
  });

  it("is absent when there is no recommendation to preview", () => {
    expect(digestWorkoutLine(null)).toBeNull();
    expect(digestWorkoutLine(rec())).toBeNull();
  });

  // #1819 item 3: the standalone "Today:" prefix restates the digest's own Today
  // heading. The BARE variant drops it — same computation, same states, no second
  // formatter for the digest to drift from.
  describe("the bare variant the digest renders under its Today heading", () => {
    const bare = { standalone: false } as const;

    it("drops the prefix from every state", () => {
      expect(
        digestWorkoutLine(
          rec({ sessionLabel: "Back", exercises: ["Lat Pulldown"] }),
          bare
        )
      ).toBe("🏋️ Back — Lat Pulldown");
      expect(
        digestWorkoutLine(
          rec({ rest: { title: "Rest day", detail: "…" } }),
          bare
        )
      ).toBe("🛌 Rest day");
      expect(
        digestWorkoutLine(
          rec({ onTrack: { title: "On track this week", detail: "…" } }),
          bare
        )
      ).toBe("✅ On track this week");
    });

    it("differs from the standalone form by the prefix alone", () => {
      const r = rec({ sessionLabel: "Push", exercises: ["Bench Press"] });
      expect(digestWorkoutLine(r)).toBe(
        digestWorkoutLine(r, bare)!.replace(/^(\S+) /, "$1 Today: ")
      );
    });

    it("still says nothing when there is nothing to preview", () => {
      expect(digestWorkoutLine(rec(), bare)).toBeNull();
    });
  });

  // ---- The head is named from the EXERCISES (#2012) ----
  //
  // Every case above sets `sessionLabel`, which short-circuits the head through `??`,
  // and the one case without a label has an empty focus AND an empty exercise list. So
  // the no-label branch — the one every profile without an active routine takes — had
  // no coverage at all, and it was passing `rec.focus` (a `MuscleRegion[]`) into
  // `suggestTitle`, which takes exercise names.
  describe("the no-sessionLabel branch names the session from the exercises", () => {
    it("titles a back day from its lifts, never 'Legs'", () => {
      // The exact reported regression: "Back" is a substring of "back squat", so
      // liftInfo("Back") returned Back Squat (region Legs) and the preview read
      // "🏋️ Legs workout — Lat Pulldown, Cable Row, Deadlift" over a pull session.
      const line = digestWorkoutLine(
        rec({
          focus: ["Back"],
          exercises: ["Lat Pulldown", "Cable Row", "Deadlift"],
        })
      );
      expect(line).not.toContain("Legs");
      expect(line).toBe(
        "🏋️ Today: Back workout — Lat Pulldown, Cable Row, Deadlift"
      );
    });

    it("does not fall into the generic 'Strength session' the guard was written to avoid", () => {
      // Passing region names guaranteed NOTHING resolved, so every focus that did not
      // contain "Back" produced the generic string — the contentless line the comment
      // above the guard promised the preview would never carry.
      for (const focus of [
        ["Chest"],
        ["Legs"],
        ["Core"],
        ["Arms", "Shoulders"],
      ] as const) {
        const line = digestWorkoutLine(
          rec({ focus: [...focus], exercises: ["Barbell Bench Press"] })
        );
        expect(line).not.toContain("Strength session");
      }
    });

    it("yields no contentless line for a focus with no exercises behind it", () => {
      // No routine day, no slate: there is nothing to name, so the digest omits the
      // line rather than printing a title with no content under it.
      expect(digestWorkoutLine(rec({ focus: ["Back", "Chest"] }))).toBeNull();
      expect(
        digestWorkoutLine(rec({ focus: ["Back"] }), { standalone: false })
      ).toBeNull();
    });

    it("composes with the cardio suffix (#2016) and the deload note", () => {
      expect(
        digestWorkoutLine(
          rec({
            focus: ["Back"],
            exercises: ["Lat Pulldown"],
            cardio: { activity: "Run", count: 1, perWeek: 2 },
            deloadWeek: true,
          })
        )
      ).toBe("🏋️ Today: Back workout — Lat Pulldown + cardio (deload week)");
    });
  });

  // THE DURABLE GUARD (#2012): the nudge and the preview name the SAME session for one
  // recommendation. This file's own header states they format one computation (#221);
  // before this they could not, by construction — the nudge read `rec.exercises` and
  // the preview read `rec.focus`.
  it("names the same session the dedicated nudge titles", () => {
    const r = rec({
      focus: ["Back"],
      exercises: ["Lat Pulldown", "Cable Row", "Deadlift"],
    });
    const nudgeTitle = formatWorkoutReminder(r)!.title;
    const preview = digestWorkoutLine(r)!;
    // "🏋️ Today's workout — Back workout" and "🏋️ Today: Back workout — …".
    expect(nudgeTitle).toContain("Back workout");
    expect(preview).toContain("Back workout");
    expect(nudgeTitle).not.toContain("Legs");
  });
});

// ---- The core names its own drivers (#2015) ----
//
// The `← today` marker is documented as "the target that DROVE today's suggestion", but
// the formatter's caller inferred it from `items[0]` — and the core pushes routine-gap
// items in a FIXED order (cardio, then strength) while the title, focus and every
// suggested exercise come from the strength half. So a day behind on both suggested a
// back workout and marked Cardio, pushing the larger deficit to second place.
//
// The assertion that did not exist: the DRIVER is computed, not hand-passed. The #1709
// tests above pin `orderBehindTargets` with a literal id and were never wrong; the bug
// lived one function upstream, in the seam between the core and the formatter.

// The reported screenshot's routine, in its own declaration order. Back is the deficit
// the message actually addresses; Red light therapy is the practice #2017 removes.
const REPORTED_ROUTINE: RoutineTargetProgress[] = [
  {
    target: { id: 1, scope_kind: "region", scope_value: "Chest" },
    count: 1,
    per_week: 2,
    met: false,
  },
  {
    target: { id: 2, scope_kind: "region", scope_value: "Back" },
    count: 0,
    per_week: 2,
    met: false,
  },
  {
    target: { id: 3, scope_kind: "type", scope_value: "cardio" },
    count: 1,
    per_week: 2,
    met: false,
  },
  {
    target: { id: 4, scope_kind: "group", scope_value: "Lower" },
    count: 1,
    per_week: 2,
    met: false,
  },
  {
    target: { id: 5, scope_kind: "practice", scope_value: "Red light therapy" },
    count: 2,
    per_week: 3,
    met: false,
  },
];

function lift(exercise: string, lastDate: string): StrengthRecent {
  return {
    exercise,
    bodyweight: false,
    lastSessionBest: {
      weightKg: 60,
      reps: 5,
      targetReps: null,
      toFailure: false,
    },
    lastDate,
  };
}

const REPORTED_STRENGTH: StrengthRecent[] = [
  lift("Lat Pulldown", "2026-06-20"),
  lift("Cable Row", "2026-06-21"),
  lift("Deadlift", "2026-06-22"),
  lift("Pull Up", "2026-06-23"),
  lift("Barbell Bench Press", "2026-07-06"),
];

const REPORTED_CARDIO: CardioRecent[] = [
  { activity: "Running", lastDate: "2026-07-02" },
];

describe("recommendNextWorkout names its own drivers (#2015/#2016)", () => {
  const nw = recommendNextWorkout({
    today: TODAY,
    routine: REPORTED_ROUTINE,
    strength: REPORTED_STRENGTH,
    cardio: REPORTED_CARDIO,
  });

  it("suggests the STRENGTH target's session", () => {
    expect(nw.focus).toEqual(["Back"]);
    expect(nw.exercises).toEqual([
      "Lat Pulldown",
      "Cable Row",
      "Deadlift",
      "Pull Up",
    ]);
  });

  it("names the strength target as a driver — the one the suggestion came from", () => {
    // Cardio is `items[0]` by construction, so the old positional read marked target 3.
    expect(nw.driverIds).toContain(2);
    expect(nw.items[0].kind).toBe("cardio");
  });

  it("names the cardio target too, because the message names that session (#2016)", () => {
    expect([...nw.driverIds].sort()).toEqual([2, 3]);
  });

  it("marks nothing when the suggestion came from habit rather than a target", () => {
    const habit = recommendNextWorkout({
      today: TODAY,
      routine: [],
      strength: REPORTED_STRENGTH,
      cardio: REPORTED_CARDIO,
    });
    expect(habit.driverIds).toEqual([]);
  });

  it("orders two drivers ahead of the rest, by deficit between them", () => {
    const ordered = orderBehindTargets(nw.behind, nw.driverIds);
    expect(ordered.map((t) => t.scopeValue)).toEqual([
      "Back", // driver, deficit 2
      "cardio", // driver, deficit 1
      "Chest", // then the rest by deficit, ties by routine order
      "Lower",
    ]);
    expect(ordered.slice(0, 2).every((t) => t.driving)).toBe(true);
    expect(ordered.slice(2).every((t) => !t.driving)).toBe(true);
  });
});

// ---- Only targets this message can help you close (#2017) ----
describe("the workout behind list is an allowlist of scope kinds (#2017)", () => {
  it("has an explicit, reasoned decision for every frequency scope kind", () => {
    // A new scope kind cannot join the workout message by omission: it has to be
    // written down here, with why, or the test fails.
    for (const kind of FREQUENCY_SCOPE_KINDS) {
      expect(WORKOUT_TARGET_SCOPES[kind]).toBeDefined();
      expect(WORKOUT_TARGET_SCOPES[kind].reason.length).toBeGreaterThan(0);
    }
    expect(Object.keys(WORKOUT_TARGET_SCOPES).sort()).toEqual(
      [...FREQUENCY_SCOPE_KINDS].sort()
    );
  });

  it("admits only the scopes a lift or a cardio session can close", () => {
    // A representative value per kind: the first ADMITTED one where the kind narrows
    // its vocabulary (#2067), any value where it does not.
    const sample = (kind: string): string =>
      WORKOUT_TARGET_SCOPES[kind].values?.[0] ?? "Chest";
    expect(
      FREQUENCY_SCOPE_KINDS.filter((k) => isWorkoutTargetScope(k, sample(k)))
    ).toEqual(["region", "group", "type"]);
  });

  it("excludes an unregistered scope kind by default", () => {
    expect(isWorkoutTargetScope("breathing_pattern", "box")).toBe(false);
  });

  // ---- and only the VALUES one can close (#2067) ----

  it("narrows `type` to strength and cardio — `sport` drives no session", () => {
    expect(isWorkoutTargetScope("type", "strength")).toBe(true);
    expect(isWorkoutTargetScope("type", "cardio")).toBe(true);
    expect(isWorkoutTargetScope("type", "sport")).toBe(false);
  });

  it("has an explicit decision for every type scope VALUE, not just the kind", () => {
    // The #2017 completeness test checked kinds, which is how `type:sport` slipped
    // through one value away. A new member of TYPE_SCOPES fails this until someone
    // decides whether the workout message can close it.
    const admitted = WORKOUT_TARGET_SCOPES.type.values ?? [];
    for (const value of admitted) expect(TYPE_SCOPES).toContain(value);
    expect(TYPE_SCOPES.filter((v) => !admitted.includes(v))).toEqual(["sport"]);
  });

  it("keeps a behind type:sport target out of the list AND out of the scope pick", () => {
    // The live mismatch: `sport` has the worse fraction, so before the narrowing it
    // both listed as a deficit and won the strength scope pick — mapping to no
    // region, it silently unscoped the suggestion and named "sport" as the target a
    // lift slate would close.
    const nw = recommendNextWorkout({
      today: TODAY,
      routine: [
        {
          target: { id: 1, scope_kind: "region", scope_value: "Back" },
          count: 1,
          per_week: 2,
          met: false,
        },
        {
          target: { id: 9, scope_kind: "type", scope_value: "sport" },
          count: 0,
          per_week: 3,
          met: false,
        },
      ],
      strength: REPORTED_STRENGTH,
      cardio: REPORTED_CARDIO,
    });
    expect(nw.behind.map((t) => t.scopeValue)).not.toContain("sport");
    expect(nw.behind.map((t) => t.scopeValue)).toEqual(["Back"]);
    expect(nw.focus).toEqual(["Back"]);
    expect(nw.items.every((i) => i.target?.scopeValue !== "sport")).toBe(true);
  });

  it("keeps a practice out of the rendered behind list", () => {
    const nw = recommendNextWorkout({
      today: TODAY,
      routine: REPORTED_ROUTINE,
      strength: REPORTED_STRENGTH,
      cardio: REPORTED_CARDIO,
    });
    expect(nw.behind.map((t) => t.scopeValue)).not.toContain(
      "Red light therapy"
    );
    expect(nw.behind.map((t) => t.scopeKind)).not.toContain("practice");
  });

  it("scopes the workout to the muscle region, not to a practice with a worse fraction", () => {
    // The bug the allowlist fixes: the scope pool was "everything that is not literally
    // type:cardio", and nothing downstream rejected a non-training target — a practice
    // names no region, so the recovery-window gate passed it unconditionally. At 0/3 it
    // beats Back's 0/2 on freshness and scopes a strength workout to a light-therapy gap.
    const nw = recommendNextWorkout({
      today: TODAY,
      routine: [
        {
          target: {
            id: 5,
            scope_kind: "practice",
            scope_value: "Red light therapy",
          },
          count: 0,
          per_week: 3,
          met: false,
        },
        {
          target: { id: 2, scope_kind: "region", scope_value: "Back" },
          count: 0,
          per_week: 2,
          met: false,
        },
      ],
      strength: REPORTED_STRENGTH,
      cardio: REPORTED_CARDIO,
    });
    expect(nw.focus).toEqual(["Back"]);
    expect(nw.driverIds).toEqual([2]);
  });

  it("yields NO strength scope when the only non-cardio target is a practice", () => {
    const nw = recommendNextWorkout({
      today: TODAY,
      routine: [
        {
          target: {
            id: 5,
            scope_kind: "practice",
            scope_value: "Red light therapy",
          },
          count: 0,
          per_week: 3,
          met: false,
        },
        {
          target: { id: 3, scope_kind: "type", scope_value: "cardio" },
          count: 1,
          per_week: 2,
          met: false,
        },
      ],
      strength: REPORTED_STRENGTH,
      cardio: REPORTED_CARDIO,
    });
    // The cardio gap is the only routine-gap item; nothing is scoped to the practice.
    expect(nw.items.map((i) => i.kind)).toEqual(["cardio"]);
    expect(nw.driverIds).toEqual([3]);
    expect(nw.behind.map((t) => t.scopeValue)).toEqual(["cardio"]);
  });

  it("keeps substance, food-group and mobility targets out too", () => {
    const nw = recommendNextWorkout({
      today: TODAY,
      routine: [
        {
          target: { id: 6, scope_kind: "substance", scope_value: "alcohol" },
          count: 1,
          per_week: 4,
          met: false,
        },
        {
          target: { id: 7, scope_kind: "food_group", scope_value: "veg" },
          count: 2,
          per_week: 14,
          met: false,
        },
        {
          target: {
            id: 8,
            scope_kind: "mobility_region",
            scope_value: "Back",
          },
          count: 0,
          per_week: 2,
          met: false,
        },
        {
          target: { id: 2, scope_kind: "region", scope_value: "Back" },
          count: 0,
          per_week: 2,
          met: false,
        },
      ],
      strength: REPORTED_STRENGTH,
      cardio: REPORTED_CARDIO,
    });
    expect(nw.behind.map((t) => t.id)).toEqual([2]);
  });
});

// ---- The message names both sessions (#2016) and discloses the weather (#2002) ----
describe("formatWorkoutReminder — the composed workout message", () => {
  const nw = recommendNextWorkout({
    today: TODAY,
    routine: REPORTED_ROUTINE,
    strength: REPORTED_STRENGTH,
    cardio: REPORTED_CARDIO,
  });

  const composed = (over: Partial<WorkoutRecommendation> = {}) =>
    formatWorkoutReminder({
      focus: nw.focus,
      exercises: nw.exercises,
      cardio: { activity: "Running", count: 1, perWeek: 2 },
      behind: orderBehindTargets(nw.behind, nw.driverIds),
      rest: null,
      onTrack: null,
      ...over,
    })!;

  it("renders the reported message with the marker on the target it suggested", () => {
    const msg = composed();
    expect(msg.title).toBe("🏋️ Today's workout — Back workout");
    expect(plainBody(msg.body)).toBe(
      [
        "Suggested: Lat Pulldown, Cable Row, Deadlift, Pull Up",
        "Plus a cardio session — Running, 1/2 this week.",
        "Behind this week: Back 0/2 ← today, Cardio 1/2 ← today, Chest 1/2, Lower body 1/2",
      ].join("\n")
    );
    // Both drivers are bolded where markup survives; nothing else is.
    const html = renderBodyHtml(msg.body);
    expect(html).toContain("<b>Back 0/2 ← today</b>");
    expect(html).toContain("<b>Cardio 1/2 ← today</b>");
    expect(html).not.toContain("<b>Chest");
  });

  it("never lists the practice target the message cannot help close", () => {
    expect(plainBody(composed().body)).not.toContain("Red light therapy");
  });

  it("is byte-identical to the strength-only message when no cardio is owed", () => {
    // This change adds nothing when there is nothing to add.
    const strengthOnly = plainBody(composed({ cardio: null }).body);
    expect(strengthOnly).not.toContain("cardio session");
    expect(strengthOnly.split("\n")).toEqual([
      "Suggested: Lat Pulldown, Cable Row, Deadlift, Pull Up",
      "Behind this week: Back 0/2 ← today, Cardio 1/2 ← today, Chest 1/2, Lower body 1/2",
    ]);
  });

  it("makes the cardio line the message when only cardio is owed", () => {
    const msg = formatWorkoutReminder({
      focus: [],
      exercises: [],
      cardio: { activity: "Running", count: 1, perWeek: 2 },
      behind: orderBehindTargets(
        [
          {
            id: 3,
            scopeKind: "type",
            scopeValue: "cardio",
            count: 1,
            perWeek: 2,
          },
        ],
        [3]
      ),
      rest: null,
      onTrack: null,
    })!;
    expect(msg.title).toBe("🏋️ Today's workout");
    expect(plainBody(msg.body)).toBe(
      [
        "Plus a cardio session — Running, 1/2 this week.",
        "Behind this week: Cardio 1/2 ← today",
      ].join("\n")
    );
  });

  it("reports the owed cardio session without inventing an activity", () => {
    expect(cardioSessionLine({ activity: null, count: 0, perWeek: 2 })).toBe(
      "Plus a cardio session — 0/2 this week."
    );
    expect(cardioSessionLine(null)).toBeNull();
  });

  it("discloses the parked activity that today's conditions displaced (#2002)", () => {
    const body = plainBody(
      composed({
        parkedNotes: [
          "Too wet for cycling (heavy rain in the morning) — Stationary Bike instead. Outdoor cycling resumes when it dries out.",
        ],
      }).body
    );
    expect(body).toContain("Too wet for cycling (heavy rain in the morning)");
    expect(body).toContain("Stationary Bike instead");
  });

  it("keeps the rest reframe free of both — a rest day pushes nothing", () => {
    const msg = composed({
      rest: { title: "Rest day", detail: "Recovery signals are low." },
      parkedNotes: ["Too wet for cycling — picking something indoors instead."],
    });
    const body = plainBody(msg.body);
    expect(body).toContain("Recovery signals are low.");
    expect(body).not.toContain("cardio session");
    expect(body).not.toContain("Too wet");
  });
});

// ---- The digest preview names the same sessions (#2016) ----
describe("digestWorkoutLine agrees with the nudge about how many sessions are owed", () => {
  const rec = (over: Partial<WorkoutRecommendation> = {}) => ({
    focus: [],
    exercises: ["Lat Pulldown", "Cable Row", "Deadlift", "Pull Up"],
    sessionLabel: "Back workout",
    behind: [],
    rest: null,
    onTrack: null,
    ...over,
  });

  it("adds the compact suffix when — and only when — a cardio session is named", () => {
    expect(
      digestWorkoutLine(
        rec({ cardio: { activity: "Running", count: 1, perWeek: 2 } })
      )
    ).toBe(
      "🏋️ Today: Back workout — Lat Pulldown, Cable Row, Deadlift + cardio"
    );
    expect(digestWorkoutLine(rec())).toBe(
      "🏋️ Today: Back workout — Lat Pulldown, Cable Row, Deadlift"
    );
  });

  it("previews a cardio-only day rather than falling silent", () => {
    expect(
      digestWorkoutLine(
        rec({
          exercises: [],
          sessionLabel: null,
          cardio: { activity: "Running", count: 1, perWeek: 2 },
        })
      )
    ).toBe("🏋️ Today: Cardio session");
  });

  it("names the same sessions the nudge names, for one recommendation", () => {
    for (const cardio of [
      null,
      { activity: "Running", count: 1, perWeek: 2 },
    ]) {
      const r = rec({ cardio });
      const nudgeNamesCardio = plainBody(
        formatWorkoutReminder(r)!.body
      ).includes("cardio session");
      expect(digestWorkoutLine(r)!.endsWith("+ cardio")).toBe(nudgeNamesCardio);
    }
  });
});
