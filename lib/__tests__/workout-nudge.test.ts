import { describe, expect, it } from "vitest";
import {
  orderBehindTargets,
  type BehindTarget,
} from "@/lib/workout-recommendation";
import { behindThisWeekLine } from "@/lib/notifications/workout-format";
import { plainBody } from "@/lib/notifications/rich-text";
import { renderBodyHtml } from "@/lib/notifications/telegram-render";
import {
  trainingSignalKey,
  isWorkoutNudgeSuppressed,
} from "@/lib/workout-nudge";
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
});
