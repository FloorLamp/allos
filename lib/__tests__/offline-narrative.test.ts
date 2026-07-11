import { describe, it, expect } from "vitest";
import {
  composeOfflineNarrative,
  offlineReasonNote,
  offlineModelTag,
  type NarrativeInput,
} from "../offline-narrative";
import {
  prToFinding,
  cardioPrToFinding,
  trendItemToFinding,
  type Finding,
} from "../findings";
import type { PR, CardioPR } from "../coaching";
import type { TrendItem } from "../trends-digest";

// A minimal well-formed input; each test overrides the slice it exercises.
function base(over: Partial<NarrativeInput> = {}): NarrativeInput {
  return {
    date: "2026-07-09",
    activity: { count: 0, types: [] },
    prs: [],
    trends: [],
    adherence: null,
    upcoming: [],
    goalCount: 0,
    ...over,
  };
}

function finding(over: Partial<Finding> & { dedupeKey: string }): Finding {
  return { domain: "test", title: "Item", ...over };
}

describe("composeOfflineNarrative", () => {
  it("returns a single sensible line when nothing is logged", () => {
    const out = composeOfflineNarrative(base());
    expect(out).toContain("Not much logged for 2026-07-09");
    // No PR/trend/adherence boilerplate leaks into the empty case.
    expect(out).not.toContain("personal record");
    expect(out).not.toContain("Supplements");
    // A single coherent line, no accidental double-spacing from empty sentences.
    expect(out).not.toMatch(/ {2,}/);
  });

  it("summarizes a rest day with no activities", () => {
    const out = composeOfflineNarrative(base({ goalCount: 2 }));
    expect(out).toContain("No activities logged for 2026-07-09");
    expect(out).toContain("2 active goals");
    expect(out).toContain("Tomorrow:");
  });

  it("names logged activities with their distinct types", () => {
    const out = composeOfflineNarrative(
      base({
        activity: { count: 3, types: ["strength", "cardio", "strength"] },
      })
    );
    expect(out).toContain("You logged 3 activities (strength and cardio)");
  });

  it("celebrates a single PR inline", () => {
    const out = composeOfflineNarrative(
      base({
        activity: { count: 1, types: ["strength"] },
        prs: [
          finding({
            domain: "pr",
            dedupeKey: "pr:strength:Back Squat:1rm",
            title: "Back Squat",
            detail: "Back Squat at 120 kg × 5",
            tone: "positive",
          }),
        ],
      })
    );
    expect(out).toContain(
      "You hit a new personal record — Back Squat at 120 kg × 5."
    );
  });

  it("lists multiple PRs and collapses the overflow", () => {
    const prs = ["a", "b", "c", "d"].map((n) =>
      finding({
        domain: "pr",
        dedupeKey: `pr:strength:${n}:1rm`,
        title: n,
        detail: `${n} at 100 kg × 5`,
        tone: "positive",
      })
    );
    const out = composeOfflineNarrative(base({ prs }));
    expect(out).toContain("New personal records:");
    expect(out).toContain("(plus 1 more)");
  });

  it("leads trends with the clinically meaningful (caution) move", () => {
    const trends: Finding[] = [
      finding({
        domain: "digest",
        dedupeKey: "digest:bio:HDL:down",
        title: "HDL",
        detail: "HDL ↓ 5% over 90d",
        tone: "neutral",
      }),
      finding({
        domain: "digest",
        dedupeKey: "digest:bio:LDL:up",
        title: "LDL",
        detail: "LDL ↑ into high range",
        tone: "caution",
      }),
    ];
    const out = composeOfflineNarrative(base({ trends }));
    const ldlPos = out.indexOf("LDL ↑ into high range");
    const hdlPos = out.indexOf("HDL ↓ 5% over 90d");
    expect(ldlPos).toBeGreaterThan(-1);
    expect(hdlPos).toBeGreaterThan(-1);
    // The caution finding is phrased before the neutral one.
    expect(ldlPos).toBeLessThan(hdlPos);
  });

  it("phrases adherence: full, slipped, and none", () => {
    expect(
      composeOfflineNarrative(base({ adherence: { taken: 5, total: 5 } }))
    ).toContain("5/5 taken — full adherence");
    expect(
      composeOfflineNarrative(base({ adherence: { taken: 4, total: 7 } }))
    ).toContain("adherence slipped to 4/7");
    expect(
      composeOfflineNarrative(base({ adherence: { taken: 0, total: 3 } }))
    ).toContain("none of 3 logged as taken");
    // total === 0 (nothing scheduled) produces no adherence sentence.
    expect(
      composeOfflineNarrative(base({ adherence: { taken: 0, total: 0 } }))
    ).not.toContain("adherence");
  });

  it("names the soonest upcoming item and the total on deck", () => {
    const upcoming: Finding[] = [
      finding({
        domain: "dose",
        dedupeKey: "dose:12",
        title: "Take magnesium",
        dueText: "today",
      }),
      finding({
        domain: "appointment",
        dedupeKey: "appt:3",
        title: "Dentist visit",
        dueText: "in 3 days",
      }),
    ];
    const out = composeOfflineNarrative(base({ upcoming }));
    expect(out).toContain(
      "Coming up: 2 items on deck, soonest Take magnesium (today)."
    );
  });

  it("composes a coherent multi-part narrative from a rich day", () => {
    const out = composeOfflineNarrative(
      base({
        activity: { count: 2, types: ["strength", "cardio"] },
        prs: [
          finding({
            domain: "pr",
            dedupeKey: "pr:strength:Squat:1rm",
            title: "Squat",
            detail: "Squat at 120 kg × 5",
            tone: "positive",
          }),
        ],
        trends: [
          finding({
            domain: "digest",
            dedupeKey: "digest:bio:LDL:up",
            title: "LDL",
            detail: "LDL ↑ into high range",
            tone: "caution",
          }),
        ],
        adherence: { taken: 4, total: 7 },
        goalCount: 3,
      })
    );
    expect(out).toContain("You logged 2 activities");
    expect(out).toContain("Squat at 120 kg × 5");
    expect(out).toContain("LDL ↑ into high range");
    expect(out).toContain("slipped to 4/7");
    expect(out).toContain("3 active goals");
    expect(out).toContain("Tomorrow:");
  });
});

describe("PR → Finding adapters", () => {
  it("maps a strength 1RM PR to a positive, prefixed finding", () => {
    const pr: PR = {
      exercise: "Back Squat",
      kind: "1rm",
      date: "2026-07-09",
      e1rmKg: 140,
      weightKg: 120,
      reps: 5,
      bodyweight: false,
    };
    const f = prToFinding(pr, "kg");
    expect(f.domain).toBe("pr");
    expect(f.dedupeKey).toBe("pr:strength:Back Squat:1rm");
    expect(f.tone).toBe("positive");
    expect(f.detail).toBe("Back Squat at 120 kg × 5");
    expect(f.dueDate).toBe("2026-07-09");
  });

  it("renders a strength PR in the reader's weight unit", () => {
    const pr: PR = {
      exercise: "Bench Press",
      kind: "1rm",
      date: "2026-07-09",
      e1rmKg: 100,
      weightKg: 100,
      reps: 3,
      bodyweight: false,
    };
    expect(prToFinding(pr, "lb").detail).toContain("lb");
  });

  it("phrases a bodyweight PR without a load", () => {
    const pr: PR = {
      exercise: "Pull-up",
      kind: "1rm",
      date: "2026-07-09",
      e1rmKg: 0,
      weightKg: 0,
      reps: 12,
      bodyweight: true,
    };
    expect(prToFinding(pr, "kg").detail).toBe("Pull-up at bodyweight × 12");
  });

  it("maps a top-set weight PR", () => {
    const pr: PR = {
      exercise: "Deadlift",
      kind: "weight",
      date: "2026-07-08",
      e1rmKg: 180,
      weightKg: 160,
      reps: 0,
      bodyweight: false,
    };
    const f = prToFinding(pr, "kg");
    expect(f.dedupeKey).toBe("pr:strength:Deadlift:weight");
    expect(f.detail).toBe("Deadlift top set at 160 kg");
  });

  it("maps cardio distance / speed / duration PRs", () => {
    const distance: CardioPR = {
      activity: "Run",
      kind: "distance",
      date: "2026-07-09",
      distanceKm: 10,
      durationMin: 0,
      speedKmh: 0,
    };
    const speed: CardioPR = {
      activity: "Cycle",
      kind: "speed",
      date: "2026-07-09",
      distanceKm: 0,
      durationMin: 0,
      speedKmh: 30,
    };
    const duration: CardioPR = {
      activity: "Row",
      kind: "duration",
      date: "2026-07-09",
      distanceKm: 0,
      durationMin: 45,
      speedKmh: 0,
    };
    expect(cardioPrToFinding(distance, "km").detail).toBe(
      "longest Run at 10 km"
    );
    expect(cardioPrToFinding(speed, "km").dedupeKey).toBe(
      "pr:cardio:Cycle:speed"
    );
    expect(cardioPrToFinding(speed, "km").detail).toContain("km/h");
    expect(cardioPrToFinding(duration, "km").detail).toContain("Row");
  });
});

// The digest adapter already exists (phase 1–3); this guards that its output
// flows through the narrator's trend selection unchanged.
describe("trend findings feed the narrative", () => {
  it("carries the digest item's text as the finding detail", () => {
    const item = {
      key: "bio:LDL",
      label: "LDL",
      direction: "up",
      rangeShift: "out-of-range",
      text: "LDL ↑ into high range",
    } as TrendItem;
    const f = trendItemToFinding(item);
    expect(f.tone).toBe("caution");
    const out = composeOfflineNarrative(base({ trends: [f] }));
    expect(out).toContain("LDL ↑ into high range");
  });
});

// Issue #411: the offline note states the ACTUAL reason it ran, never a lie about
// a missing key when the real cause is the daily cap or a failed call.
describe("offlineReasonNote (#411)", () => {
  it("tells the unconfigured user to set the key", () => {
    expect(offlineReasonNote("no-key")).toContain("set ANTHROPIC_API_KEY");
  });

  it("tells the rate-limited user the daily limit was reached — never to set a key", () => {
    const note = offlineReasonNote("cap-exhausted");
    expect(note).toContain("daily AI limit reached");
    expect(note).toContain("try again tomorrow");
    // The key IS set — never send them to configure one.
    expect(note).not.toContain("ANTHROPIC_API_KEY");
  });

  it("tells the errored user the AI was temporarily unavailable — never to set a key", () => {
    const note = offlineReasonNote("failed");
    expect(note).toContain("temporarily unavailable");
    expect(note).not.toContain("ANTHROPIC_API_KEY");
  });

  it("gives each reason a distinct, honest model tag", () => {
    expect(offlineModelTag("no-key")).toBe("offline/no-key");
    expect(offlineModelTag("cap-exhausted")).toBe("offline/cap-exhausted");
    expect(offlineModelTag("failed")).toBe("offline/failed");
  });
});
