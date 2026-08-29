import { describe, expect, it } from "vitest";
import {
  diffRecentActivities,
  recencyHorizonStart,
  SHARED_RECENCY_HORIZON_DAYS,
  type SharedActivitySnapshot,
} from "@/e2e/shared-profile-guard";

// A GREEN SWEEP OVER A COMPLYING TREE SAYS NOTHING ABOUT WHAT THE SWEEP CAN SEE, so
// the widened shared-profile guard (#3946) is exercised here against snapshots
// written to break it — and, just as importantly, against the benign neighbours it
// must stay quiet on. Both halves are load-bearing: a guard that cried wolf on
// `training-log-merge`'s undo would have been deleted within a week, taking the real
// guard with it, and one that a `sharedProfileLeftovers` declaration silenced
// WHOLESALE would be the allowlist this design exists to avoid.

const snap = (...rows: [number, string][]): SharedActivitySnapshot =>
  rows.map(([id, signature]) => ({ id, signature }));

const SEEDED: [number, string][] = [
  [10, "2026-08-01|cardio|Cycling"],
  [11, "2026-08-02|strength|Bench Press"],
];

describe("the shared-profile activity diff sees what a later test would see", () => {
  it.each([
    [
      "a stranded save — #3930 exactly",
      snap(...SEEDED),
      snap(...SEEDED, [12, "2026-08-29|cardio|Running"]),
      { added: ["Running"], missing: 0 },
    ],
    [
      "a seeded row deleted — the same defect pointing the other way",
      snap(...SEEDED),
      snap(SEEDED[1]),
      { added: [], missing: 1 },
    ],
    [
      "a seeded row re-dated in place onto today",
      snap(...SEEDED),
      snap(SEEDED[1], [10, "2026-08-29|cardio|Cycling"]),
      { added: ["Cycling"], missing: 1 },
    ],
    [
      "a row destroyed and restored under a NEW id — training-log-merge's undo",
      snap(...SEEDED),
      snap(SEEDED[1], [99, "2026-08-01|cardio|Cycling"]),
      { added: [], missing: 0 },
    ],
    [
      "a row created and destroyed within the test — trash, undo-delete",
      snap(...SEEDED),
      snap(...SEEDED),
      { added: [], missing: 0 },
    ],
  ])("%s", (_name, before, after, expected) => {
    const drift = diffRecentActivities(before, after);
    expect(drift.added.map((r) => r.title)).toEqual(expected.added);
    expect(drift.missing).toHaveLength(expected.missing);
    expect(drift.staleDeclarations).toEqual([]);
  });

  // A declaration covers the TITLES it names and nothing else — the property that
  // separates it from a list of exempt spec names.
  it("a declaration silences the rows it names, in both directions, and only those", () => {
    const declared = {
      why: "the merge consumes it",
      titles: ["Set merge dupe"],
    };
    const before = snap(...SEEDED, [12, "2026-08-26|strength|Set merge dupe"]);
    const after = snap(...SEEDED, [13, "2026-08-29|cardio|Running"]);
    const drift = diffRecentActivities(before, after, declared);
    expect(drift.missing).toEqual([]);
    expect(drift.added.map((r) => r.title)).toEqual(["Running"]);
    expect(drift.staleDeclarations).toEqual([]);
  });

  // A DECLARATION THAT COVERS NOTHING IS AN EXEMPTION NOBODY CAN SEE THE EDGE OF.
  // This does NOT check that a live `why` is true — nothing does (#3260) — only that
  // the declaration is still NEEDED, which is the half that rots first.
  it.each([
    [
      "the declared row is no longer left — a cleanup was added",
      { why: "consumed by the merge", titles: ["Set merge dupe"] },
      snap(...SEEDED, [12, "2026-08-26|strength|Set merge dupe"]),
      ["Set merge dupe"],
    ],
    [
      "one declared title still applies and the other does not",
      {
        why: "consumed by the merge",
        titles: ["Set merge dupe", "Gone fixture"],
      },
      snap(SEEDED[1]),
      ["Gone fixture"],
    ],
  ])("%s", (_name, declared, after, expectedStale) => {
    const before = snap(...SEEDED, [12, "2026-08-26|strength|Set merge dupe"]);
    const drift = diffRecentActivities(before, after, declared);
    expect(drift.staleDeclarations).toEqual(expectedStale);
  });

  // The horizon is a pure function of the instant it is handed, so a run at any hour
  // of any day watches the same 84 days back from ITS OWN frozen clock. Reading the
  // wall clock here would make the guard behave differently depending on when CI ran,
  // which is the defect it exists to catch.
  it.each([
    ["2026-08-29T05:12:00.000Z", "2026-06-06"],
    ["2026-01-01T23:59:00.000Z", "2025-10-09"],
  ])("the horizon start for %s is %s", (instant, expected) => {
    expect(recencyHorizonStart(new Date(instant))).toBe(expected);
    expect(SHARED_RECENCY_HORIZON_DAYS).toBe(84);
  });
});
