// The shared nudge-cadence decision (issue #2036 §3).
//
// Four planners — refill, preventive, illness-care (which the temp-red-flag nudge shares
// outright) and follow-up — had each re-derived "send / freeze / self-healing sweep" by
// hand. These tests exercise the engine directly on its own vocabulary, and then pin
// that each domain's DOCUMENTED cadence still falls out of it from shared fixtures, so
// the extraction cannot quietly change what any of the five nudges does.
//
// The domains' own suites (refill-nudge, preventive-nudge, followup-nudge, illness-care)
// are unedited by this issue and remain the behaviour-preservation proof.

import { describe, it, expect } from "vitest";
import {
  ONCE_PER_EPISODE,
  ONCE_PER_EPISODE_FROZEN_KEEPS,
  planNudgeCadence,
  type NudgeCandidate,
} from "@/lib/nudge-cadence";
import { planRefillNudges } from "@/lib/refill-nudge";
import { planPreventiveNudges } from "@/lib/preventive-nudge";
import { planIllnessCareNudges } from "@/lib/illness-care";
import { FOLLOWUP_REPEAT_DAYS, planFollowUpNudges } from "@/lib/followup-nudge";

// A candidate in the engine's own vocabulary. `item` is opaque to the engine.
function cand(
  key: number,
  actionable: boolean,
  sends = 0,
  firstSentDate: string | null = null
): NudgeCandidate<number, string> {
  return { key, item: `item-${key}`, actionable, sends, firstSentDate };
}

describe("planNudgeCadence: rule 1 — send (#2036)", () => {
  it("sends a live, unmarked candidate as the FIRST send", () => {
    const plan = planNudgeCadence({
      candidates: [cand(1, true)],
      marked: [],
      policy: ONCE_PER_EPISODE,
    });
    expect(plan.toSend).toEqual([{ key: 1, item: "item-1", stage: "first" }]);
    expect(plan.toClear).toEqual([]);
  });

  it("stays silent for a live candidate whose cadence is spent", () => {
    const plan = planNudgeCadence({
      candidates: [cand(1, true, 1)],
      marked: [1],
      policy: ONCE_PER_EPISODE,
    });
    expect(plan.toSend).toEqual([]);
    // Still live, so nothing to sweep either.
    expect(plan.toClear).toEqual([]);
  });

  it("never sends a candidate whose condition is not live", () => {
    const plan = planNudgeCadence({
      candidates: [cand(1, false)],
      marked: [],
      policy: ONCE_PER_EPISODE,
    });
    expect(plan.toSend).toEqual([]);
  });
});

describe("planNudgeCadence: rule 2 — freeze (#2036)", () => {
  it("holds a frozen candidate out of the send", () => {
    const plan = planNudgeCadence({
      candidates: [cand(1, true), cand(2, true)],
      marked: [],
      frozen: [1],
      policy: ONCE_PER_EPISODE,
    });
    expect(plan.toSend.map((s) => s.key)).toEqual([2]);
  });

  it("leaves a frozen candidate's marker exactly as it stood", () => {
    // The whole point of freezing rather than clearing: un-dismissing resumes the
    // lifecycle instead of restarting it.
    const plan = planNudgeCadence({
      candidates: [cand(1, true, 1)],
      marked: [1],
      frozen: [1],
      policy: ONCE_PER_EPISODE,
    });
    expect(plan.toSend).toEqual([]);
    expect(plan.toClear).toEqual([]);
  });

  it("sweeps a frozen key that has gone dead when the policy allows it", () => {
    // refill / follow-up posture: a subject that is not live carries no visible finding,
    // so the freeze is itself stale.
    const plan = planNudgeCadence({
      candidates: [],
      marked: [7],
      frozen: [7],
      policy: ONCE_PER_EPISODE,
    });
    expect(plan.toClear).toEqual([7]);
  });

  it("keeps a frozen dead key's marker when the policy says so", () => {
    // preventive / illness-care posture (#183): clearing here would age the marker out
    // and let a later un-cover re-nudge the SAME episode.
    const plan = planNudgeCadence({
      candidates: [],
      marked: [7],
      frozen: [7],
      policy: ONCE_PER_EPISODE_FROZEN_KEEPS,
    });
    expect(plan.toClear).toEqual([]);
  });
});

describe("planNudgeCadence: rule 3 — the self-healing sweep (#325/#2036)", () => {
  it("sweeps a marker whose subject is no longer live", () => {
    const plan = planNudgeCadence({
      candidates: [cand(1, false)],
      marked: [1],
      policy: ONCE_PER_EPISODE,
    });
    expect(plan.toClear).toEqual([1]);
  });

  it("sweeps a marker whose subject vanished entirely", () => {
    // `marked` is the FULL live-marker set, never just the candidates' keys — which is
    // what makes the sweep cover a route nobody enumerated.
    const plan = planNudgeCadence({
      candidates: [cand(1, true)],
      marked: [1, 99],
      policy: ONCE_PER_EPISODE,
    });
    expect(plan.toClear).toEqual([99]);
  });

  it("never sweeps a marker whose subject is still live", () => {
    const plan = planNudgeCadence({
      candidates: [cand(1, true, 1)],
      marked: [1],
      policy: ONCE_PER_EPISODE,
    });
    expect(plan.toClear).toEqual([]);
  });
});

describe("planNudgeCadence: the repeat cadence (#1866/#2036)", () => {
  const REPEAT = { maxSends: 2, repeatDays: 21, frozenBlocksClear: false };

  it("repeats once the spacing has elapsed, framed as the repeat", () => {
    const plan = planNudgeCadence({
      candidates: [cand(1, true, 1, "2026-01-01")],
      marked: [1],
      today: "2026-01-22",
      policy: REPEAT,
    });
    expect(plan.toSend).toEqual([{ key: 1, item: "item-1", stage: "repeat" }]);
  });

  it("waits while the spacing has not elapsed", () => {
    const plan = planNudgeCadence({
      candidates: [cand(1, true, 1, "2026-01-01")],
      marked: [1],
      today: "2026-01-21",
      policy: REPEAT,
    });
    expect(plan.toSend).toEqual([]);
  });

  it("goes silent forever once the cadence is spent", () => {
    const plan = planNudgeCadence({
      candidates: [cand(1, true, 2, "2026-01-01")],
      marked: [1],
      today: "2027-01-01",
      policy: REPEAT,
    });
    expect(plan.toSend).toEqual([]);
  });

  it("spaces the repeat off the FIRST send, not the latest", () => {
    // The marker records every send date; the anchor is deliberately the first, so a
    // cadence cannot be walked forward indefinitely.
    const plan = planNudgeCadence({
      candidates: [cand(1, true, 1, "2026-01-01")],
      marked: [1],
      today: "2026-01-22",
      policy: { ...REPEAT, repeatDays: 21 },
    });
    expect(plan.toSend[0].stage).toBe("repeat");
  });

  it("stays silent rather than guessing when no anchor date was recorded", () => {
    const plan = planNudgeCadence({
      candidates: [cand(1, true, 1, null)],
      marked: [1],
      today: "2030-01-01",
      policy: REPEAT,
    });
    expect(plan.toSend).toEqual([]);
  });
});

// ── The four planners' documented cadences, from shared fixtures ─────────────
// Same story told four ways: one live subject already nudged, one live subject never
// nudged, one dead subject holding a stale marker, one live-but-silenced subject.

describe("the four planners reproduce their documented cadences (#2036)", () => {
  it("refill: once per low-supply episode, self-healing clear, frozen dismissal", () => {
    const plan = planRefillNudges(
      [
        { id: 1, name: "Marked & low", daysLeft: 2, low: true },
        { id: 2, name: "Fresh & low", daysLeft: 3, low: true },
        { id: 3, name: "Refilled", daysLeft: 40, low: false },
        { id: 4, name: "Low but dismissed", daysLeft: 1, low: true },
      ],
      [1, 3, 9],
      [4]
    );
    expect(plan.toSend.map((i) => i.id)).toEqual([2]);
    // 3 recovered (episode over) and 9 vanished from the tracked set entirely.
    expect(plan.toClear).toEqual([3, 9]);
  });

  it("refill: an unestimable rate is not a low-supply episode", () => {
    const plan = planRefillNudges(
      [{ id: 1, name: "No rate", daysLeft: null, low: true }],
      [1]
    );
    expect(plan.toSend).toEqual([]);
    expect(plan.toClear).toEqual([1]);
  });

  it("preventive: once per due episode, and a covered rule FREEZES its marker", () => {
    const item = (ruleKey: string) => ({
      ruleKey,
      name: ruleKey,
      status: "due" as const,
      detail: null,
      href: null,
      ctaLabel: null,
    });
    const plan = planPreventiveNudges(
      [item("marked"), item("fresh"), item("covered")],
      ["marked", "covered", "satisfied", "dismissed-and-gone"],
      ["covered"],
      ["dismissed-and-gone"]
    );
    expect(plan.toSend.map((i) => i.ruleKey)).toEqual(["fresh"]);
    // `covered` keeps its marker even though it is frozen; `dismissed-and-gone` is
    // frozen AND out of the actionable slice, and the preventive posture keeps it too.
    expect(plan.toClear).toEqual(["satisfied"]);
  });

  it("illness-care: the same cadence, keyed by the finding's dedupeKey", () => {
    const plan = planIllnessCareNudges(
      ["illness-care:a", "illness-care:b"],
      ["illness-care:a", "illness-care:closed"],
      ["illness-care:b"]
    );
    expect(plan.toSend).toEqual([]);
    expect(plan.toClear).toEqual(["illness-care:closed"]);
  });

  it("follow-up: one send, one repeat weeks later, then nothing ever", () => {
    const today = "2026-06-01";
    const firstSent = "2026-05-01"; // > FOLLOWUP_REPEAT_DAYS ago
    expect(FOLLOWUP_REPEAT_DAYS).toBe(21);
    const plan = planFollowUpNudges(
      [
        { id: 1, sentDates: [] },
        { id: 2, sentDates: [firstSent] },
        { id: 3, sentDates: [firstSent, "2026-05-22"] },
        { id: 4, sentDates: [] },
      ],
      [2, 3, 77],
      [4],
      today
    );
    expect(plan.toSend).toEqual([
      { id: 1, stage: "first" },
      { id: 2, stage: "repeat" },
    ]);
    // 77 left the overdue set (settled, resolved, deleted or re-dated).
    expect(plan.toClear).toEqual([77]);
  });

  it("follow-up: a suppressed follow-up is frozen, never cleared", () => {
    const plan = planFollowUpNudges(
      [{ id: 4, sentDates: ["2026-01-01"] }],
      [4],
      [4],
      "2026-06-01"
    );
    expect(plan.toSend).toEqual([]);
    expect(plan.toClear).toEqual([]);
  });
});
