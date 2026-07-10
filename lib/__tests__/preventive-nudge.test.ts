import { describe, expect, it } from "vitest";
import {
  planPreventiveNudges,
  type PreventiveNudgeItem,
} from "@/lib/preventive-nudge";
import {
  preventiveSignalKey,
  preventiveAssessmentToUpcomingItem,
} from "@/lib/preventive-upcoming";
import type { PreventiveAssessment } from "@/lib/preventive-status";

// Episode-dedup for the proactive preventive-care nudge (issue #87), mirroring the
// refill nudge's "once per episode" tests. planPreventiveNudges is pure: given the
// currently due/overdue items and the already-nudged rule keys, it returns which
// items to send now and which stale markers to clear.

const item = (
  ruleKey: string,
  status: "due" | "overdue" = "due"
): PreventiveNudgeItem => ({
  ruleKey,
  name: ruleKey,
  status,
  detail: null,
});

describe("planPreventiveNudges", () => {
  it("sends every actionable item when nothing has been nudged yet", () => {
    const plan = planPreventiveNudges(
      [item("colorectal_cancer", "overdue"), item("lipid_screening")],
      []
    );
    expect(plan.toSend.map((i) => i.ruleKey)).toEqual([
      "colorectal_cancer",
      "lipid_screening",
    ]);
    expect(plan.toClear).toEqual([]);
  });

  it("suppresses an item that is still due and already marked (once per episode)", () => {
    // colorectal was nudged last episode and is STILL overdue → no re-send; lipid is
    // newly due → send.
    const plan = planPreventiveNudges(
      [item("colorectal_cancer", "overdue"), item("lipid_screening")],
      ["colorectal_cancer"]
    );
    expect(plan.toSend.map((i) => i.ruleKey)).toEqual(["lipid_screening"]);
    expect(plan.toClear).toEqual([]);
  });

  it("clears a marker once its rule is no longer actionable (episode ended)", () => {
    // colorectal was nudged, but is now satisfied/overridden so it's absent from the
    // actionable set → clear its marker so a future due can nudge again.
    const plan = planPreventiveNudges(
      [item("lipid_screening")],
      ["colorectal_cancer", "lipid_screening"]
    );
    expect(plan.toSend).toEqual([]); // lipid already marked, still due
    expect(plan.toClear).toEqual(["colorectal_cancer"]);
  });

  it("re-fires after an episode ends and the next interval comes due", () => {
    // Episode 1: due + unmarked → send (caller then sets the marker).
    const first = planPreventiveNudges([item("mammography")], []);
    expect(first.toSend.map((i) => i.ruleKey)).toEqual(["mammography"]);

    // Satisfied: not actionable, marker present → clear (caller deletes it).
    const ended = planPreventiveNudges([], ["mammography"]);
    expect(ended.toSend).toEqual([]);
    expect(ended.toClear).toEqual(["mammography"]);

    // Next interval: due again with NO marker → a fresh nudge fires.
    const next = planPreventiveNudges([item("mammography")], []);
    expect(next.toSend.map((i) => i.ruleKey)).toEqual(["mammography"]);
  });

  it("does nothing when there is nothing due and no markers", () => {
    const plan = planPreventiveNudges([], []);
    expect(plan.toSend).toEqual([]);
    expect(plan.toClear).toEqual([]);
  });

  it("both sends new items and clears stale markers in one pass", () => {
    const plan = planPreventiveNudges(
      [item("lipid_screening"), item("diabetes_screening", "overdue")],
      ["mammography", "lipid_screening"]
    );
    // diabetes is new (send); lipid still due + marked (suppress); mammography no
    // longer actionable (clear).
    expect(plan.toSend.map((i) => i.ruleKey)).toEqual(["diabetes_screening"]);
    expect(plan.toClear).toEqual(["mammography"]);
  });

  it("returns toClear sorted for deterministic output", () => {
    const plan = planPreventiveNudges([], ["skin_check", "aaa_ultrasound"]);
    expect(plan.toClear).toEqual(["aaa_ultrasound", "skin_check"]);
  });

  // Scheduled-visit coverage (issue #183): a due item with a booked matching-kind
  // visit is held out of the nudge without touching its episode marker, matching the
  // Upcoming page's "Scheduled" quiet state (issue #85).
  describe("scheduled-visit coverage", () => {
    it("does not nudge a covered item, and never sets its marker", () => {
      // Item is due and unmarked, but a matching visit is booked → suppress the ping;
      // since it's not marked, nothing to clear either (its episode stays un-started).
      const plan = planPreventiveNudges(
        [item("colorectal_cancer", "overdue"), item("lipid_screening")],
        [],
        ["colorectal_cancer"]
      );
      expect(plan.toSend.map((i) => i.ruleKey)).toEqual(["lipid_screening"]);
      expect(plan.toClear).toEqual([]);
    });

    it("re-allows the nudge once the covering appointment is cancelled", () => {
      // Covered → no send.
      const covered = planPreventiveNudges(
        [item("colorectal_cancer", "overdue")],
        [],
        ["colorectal_cancer"]
      );
      expect(covered.toSend).toEqual([]);
      expect(covered.toClear).toEqual([]);

      // Appointment cancelled (no longer covered), still due + unmarked → nudge fires.
      const uncovered = planPreventiveNudges(
        [item("colorectal_cancer", "overdue")],
        [],
        []
      );
      expect(uncovered.toSend.map((i) => i.ruleKey)).toEqual([
        "colorectal_cancer",
      ]);
      expect(uncovered.toClear).toEqual([]);
    });

    it("freezes a marked item's episode while covered, then ends it normally", () => {
      // Episode 1: due + unmarked, uncovered → send (caller sets the marker).
      const first = planPreventiveNudges([item("mammography")], [], []);
      expect(first.toSend.map((i) => i.ruleKey)).toEqual(["mammography"]);

      // User books a matching visit: still due, now marked AND covered → no re-send,
      // and the marker is NOT cleared (episode frozen, not ended).
      const booked = planPreventiveNudges(
        [item("mammography")],
        ["mammography"],
        ["mammography"]
      );
      expect(booked.toSend).toEqual([]);
      expect(booked.toClear).toEqual([]);

      // Visit completed → item satisfied (no longer actionable), no longer covered,
      // marker present → clear it so the next interval can re-fire.
      const done = planPreventiveNudges([], ["mammography"], []);
      expect(done.toSend).toEqual([]);
      expect(done.toClear).toEqual(["mammography"]);
    });

    it("does not double-nudge the same episode when coverage is cancelled mid-episode", () => {
      // Nudged (marked), then covered by a booking, then the booking is cancelled
      // while the item is STILL due. Because the marker was preserved through the
      // covered tick, the un-covered tick suppresses (already nudged this episode).
      const booked = planPreventiveNudges(
        [item("mammography")],
        ["mammography"],
        ["mammography"]
      );
      expect(booked.toClear).toEqual([]); // marker preserved

      const cancelled = planPreventiveNudges(
        [item("mammography")],
        ["mammography"],
        []
      );
      expect(cancelled.toSend).toEqual([]); // still marked → no duplicate ping
      expect(cancelled.toClear).toEqual([]);
    });

    it("defaults to no coverage when the set is omitted (back-compat)", () => {
      const plan = planPreventiveNudges([item("lipid_screening")], []);
      expect(plan.toSend.map((i) => i.ruleKey)).toEqual(["lipid_screening"]);
      expect(plan.toClear).toEqual([]);
    });
  });

  // Page suppression (issue #227): a rule dismissed/snoozed on the Upcoming page is
  // held out of the nudge with its episode marker frozen — the same treatment as a
  // covered rule, but sourced from the shared findings-suppression bus.
  describe("page suppression (#227)", () => {
    it("does not nudge a suppressed item, and never sets its marker", () => {
      const plan = planPreventiveNudges(
        [item("colorectal_cancer", "overdue"), item("lipid_screening")],
        [],
        [],
        ["colorectal_cancer"]
      );
      expect(plan.toSend.map((i) => i.ruleKey)).toEqual(["lipid_screening"]);
      expect(plan.toClear).toEqual([]);
    });

    it("re-allows the nudge once the item is un-dismissed", () => {
      const suppressed = planPreventiveNudges(
        [item("colorectal_cancer", "overdue")],
        [],
        [],
        ["colorectal_cancer"]
      );
      expect(suppressed.toSend).toEqual([]);
      expect(suppressed.toClear).toEqual([]);

      const restored = planPreventiveNudges(
        [item("colorectal_cancer", "overdue")],
        [],
        [],
        []
      );
      expect(restored.toSend.map((i) => i.ruleKey)).toEqual([
        "colorectal_cancer",
      ]);
    });

    it("freezes a marked item's episode while suppressed (no double-nudge on restore)", () => {
      // Nudged (marked), then dismissed while still due → no re-send, marker preserved.
      const dismissed = planPreventiveNudges(
        [item("mammography")],
        ["mammography"],
        [],
        ["mammography"]
      );
      expect(dismissed.toSend).toEqual([]);
      expect(dismissed.toClear).toEqual([]); // marker frozen, not cleared

      // Un-dismissed, still due + still marked → no duplicate ping (same episode).
      const restored = planPreventiveNudges(
        [item("mammography")],
        ["mammography"],
        [],
        []
      );
      expect(restored.toSend).toEqual([]);
      expect(restored.toClear).toEqual([]);
    });

    it("does not clear a suppressed rule's marker even once it's no longer actionable", () => {
      // Suppressed AND no longer due: still frozen, so the marker survives — the
      // dismissal, not the episode lifecycle, governs while suppression stands.
      const plan = planPreventiveNudges(
        [],
        ["mammography"],
        [],
        ["mammography"]
      );
      expect(plan.toSend).toEqual([]);
      expect(plan.toClear).toEqual([]);
    });
  });
});

// The crux of #227: the push must compute the IDENTICAL dedupeKey the Upcoming item
// carries, or a page dismissal won't line up with the nudge. Both derive from
// preventiveSignalKey, so this pins that they can't drift.
describe("preventiveSignalKey ↔ Upcoming item key", () => {
  const assessment: PreventiveAssessment = {
    key: "colorectal_cancer",
    name: "Colorectal cancer screening",
    kind: "screening",
    status: "overdue",
    lastDate: null,
    nextDueDate: null,
    nextDueAgeMonths: null,
    detail: "Overdue",
    nextLabel: "Overdue",
    href: null,
    override: null,
    citation: { source: "USPSTF", summary: "test", reviewed: "2026-07" },
  };

  it("namespaces by kind: `<kind>:<ruleKey>`", () => {
    expect(preventiveSignalKey("screening", "colorectal_cancer")).toBe(
      "screening:colorectal_cancer"
    );
    expect(preventiveSignalKey("visit", "well_adult")).toBe("visit:well_adult");
  });

  it("equals the key the Upcoming item builder produces", () => {
    const item = preventiveAssessmentToUpcomingItem(assessment, {
      today: "2026-07-10",
    });
    expect(item.key).toBe(preventiveSignalKey(assessment.kind, assessment.key));
  });
});
