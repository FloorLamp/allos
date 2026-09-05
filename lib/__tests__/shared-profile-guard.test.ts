import { describe, expect, it } from "vitest";
import {
  diffSharedRows,
  horizonStart,
  recencyHorizonStart,
  SHARED_RECENCY_HORIZON_DAYS,
  sharedRowDriftMessage,
  WATCHED_SHARED_TABLES,
  type SharedRowSnapshot,
} from "@/e2e/shared-profile-guard";

// A GREEN SWEEP OVER A COMPLYING TREE SAYS NOTHING ABOUT WHAT THE SWEEP CAN SEE, so
// the shared-profile guard (#3946, widened by #5037) is exercised here against
// snapshots written to break it — and, just as importantly, against the benign
// neighbours it must stay quiet on. Both halves are load-bearing: a guard that cried
// wolf on `training-log-merge`'s undo would have been deleted within a week, taking
// the real guard with it, and one that a `sharedProfileLeftovers` declaration
// silenced WHOLESALE would be the allowlist this design exists to avoid.

const NOW = new Date("2026-09-05T13:00:00.000Z");
const TODAY = "2026-09-05";

const row = (
  table: string,
  id: number,
  handle: string,
  signature: string
): SharedRowSnapshot[number] => ({ table, id, handle, signature });

const act = (id: number, signature: string) =>
  row("activities", id, signature.split("|").slice(2).join("|"), signature);
const sample = (id: number, signature: string) =>
  row("metric_samples", id, signature.split("|")[1], signature);
const mood = (id: number, signature: string) =>
  row("mood_logs", id, signature.split("|")[0], signature);

const snap = (...rows: SharedRowSnapshot): SharedRowSnapshot => rows;

const SEEDED_ACTIVITIES: SharedRowSnapshot = [
  act(10, "2026-08-01|cardio|Cycling"),
  act(11, "2026-08-02|strength|Bench Press"),
];
// The night and nap #5037's measurements-form write replaced, in the seed's shape.
const SEEDED_NIGHT = sample(
  20,
  `${TODAY}|sleep_min|manual|2026-09-04T12:00:00.000Z|2026-09-04T17:00:00.000Z|300`
);
const SEEDED_NAP = sample(
  21,
  `${TODAY}|sleep_min|manual|2026-09-05T02:00:00.000Z|2026-09-05T02:45:00.000Z|45`
);
const SEEDED_MOOD = mood(30, `${TODAY}|3|3|2||`);
const SEEDED: SharedRowSnapshot = [
  ...SEEDED_ACTIVITIES,
  SEEDED_NIGHT,
  SEEDED_NAP,
  SEEDED_MOOD,
];

describe("the shared-profile diff sees what a later test would see", () => {
  it.each([
    // ── activities, the #3946 cases, unchanged by the widening ───────────────
    [
      "a stranded save — #3930 exactly",
      snap(...SEEDED),
      snap(...SEEDED, act(12, "2026-08-29|cardio|Running")),
      { added: ["Running"], missing: 0 },
    ],
    [
      "a seeded activity deleted — the same defect pointing the other way",
      snap(...SEEDED),
      snap(...SEEDED.filter((r) => r.id !== 10)),
      { added: [], missing: 1 },
    ],
    [
      "a seeded activity re-dated in place onto today",
      snap(...SEEDED),
      snap(
        ...SEEDED.filter((r) => r.id !== 10),
        act(10, "2026-08-29|cardio|Cycling")
      ),
      { added: ["Cycling"], missing: 1 },
    ],
    [
      "a row destroyed and restored under a NEW id — training-log-merge's undo",
      snap(...SEEDED),
      snap(
        ...SEEDED.filter((r) => r.id !== 10),
        act(99, "2026-08-01|cardio|Cycling")
      ),
      { added: [], missing: 0 },
    ],
    [
      "a row created and destroyed within the test — trash, undo-delete",
      snap(...SEEDED),
      snap(...SEEDED),
      { added: [], missing: 0 },
    ],
    // ── metric_samples: the gap #5037 measured ───────────────────────────────
    [
      "A LEAKED INSERT: a today-dated reading the form added",
      snap(...SEEDED),
      snap(...SEEDED, sample(22, `${TODAY}|hydration_l|manual|x|x|2.4`)),
      { added: ["hydration_l"], missing: 0 },
    ],
    [
      "A LEAKED UPDATE: manual-vitals' sleep save, which REPLACES the day",
      snap(...SEEDED),
      snap(
        ...SEEDED.filter((r) => r.table !== "metric_samples"),
        sample(
          23,
          `${TODAY}|sleep_min|manual|${TODAY}T00:00:00|${TODAY}T00:00:00|450`
        )
      ),
      { added: ["sleep_min"], missing: 2 },
    ],
    [
      "A LEAKED DELETE: measurements-form-layout, which removed two seeded rows",
      snap(...SEEDED),
      snap(...SEEDED.filter((r) => r.table !== "metric_samples")),
      { added: [], missing: 2 },
    ],
    [
      "a mood check-in overwriting the day's — mood_logs is UNIQUE per date",
      snap(...SEEDED),
      snap(
        ...SEEDED.filter((r) => r.id !== 30),
        mood(31, `${TODAY}|5|4|1|["work"]|good`)
      ),
      { added: [TODAY], missing: 1 },
    ],
    // ── the horizon is a boundary, and rows sit on both sides of it ──────────
    [
      "a 2019-dated reading — undo-delete's HRV row, outside today's bound",
      snap(...SEEDED),
      snap(...SEEDED, sample(24, "2019-03-04|hrv_ms|manual|x|x|55")),
      { added: [], missing: 0 },
    ],
    [
      "a 2026-01 activity — import-dedup's merge, outside the 84-day bound",
      snap(...SEEDED),
      snap(...SEEDED, act(25, "2026-01-02|cardio|Afternoon Run")),
      { added: [], missing: 0 },
    ],
  ])("%s", (_name, before, after, expected) => {
    // The out-of-horizon cases are written as rows the SNAPSHOT would never have
    // returned, so they are filtered the way `snapshotSharedRows` filters them —
    // the diff itself is deliberately horizon-blind.
    const inHorizon = (rows: SharedRowSnapshot) =>
      rows.filter((r) => {
        const watched = WATCHED_SHARED_TABLES.find((w) => w.table === r.table)!;
        return (
          r.signature.split("|")[0] >= horizonStart(NOW, watched.horizonDays)
        );
      });
    const drift = diffSharedRows(inHorizon(before), inHorizon(after));
    expect(drift.added.map((r) => r.handle)).toEqual(expected.added);
    expect(drift.missing.reduce((n, r) => n + r.count, 0)).toBe(
      expected.missing
    );
    expect(drift.staleDeclarations).toEqual([]);
  });

  // A declaration covers the HANDLES it names and nothing else — the property that
  // separates it from a list of exempt spec names. It spans tables, because one
  // flat list is the whole mechanism.
  it("a declaration silences the rows it names, in both directions, and only those", () => {
    const declared = {
      why: "the merge consumes it",
      rows: ["Set merge dupe", "hydration_l"],
    };
    const before = snap(
      ...SEEDED,
      act(12, "2026-08-26|strength|Set merge dupe")
    );
    const after = snap(
      ...SEEDED,
      sample(22, `${TODAY}|hydration_l|manual|x|x|2.4`),
      act(13, "2026-08-29|cardio|Running")
    );
    const drift = diffSharedRows(before, after, declared);
    expect(drift.missing).toEqual([]);
    expect(drift.added.map((r) => r.handle)).toEqual(["Running"]);
    expect(drift.staleDeclarations).toEqual([]);
  });

  // A DECLARATION THAT COVERS NOTHING IS AN EXEMPTION NOBODY CAN SEE THE EDGE OF.
  // This does NOT check that a live `why` is true — nothing does (#3260) — only that
  // the declaration is still NEEDED, which is the half that rots first.
  it.each([
    [
      "the declared row is no longer left — a cleanup was added",
      { why: "consumed by the merge", rows: ["Set merge dupe"] },
      snap(...SEEDED, act(12, "2026-08-26|strength|Set merge dupe")),
      ["Set merge dupe"],
    ],
    [
      "one declared handle still applies and the other does not",
      {
        why: "consumed by the merge",
        rows: ["Set merge dupe", "Gone fixture"],
      },
      snap(...SEEDED.filter((r) => r.id !== 10)),
      ["Gone fixture"],
    ],
  ])("%s", (_name, declared, after, expectedStale) => {
    const before = snap(
      ...SEEDED,
      act(12, "2026-08-26|strength|Set merge dupe")
    );
    const drift = diffSharedRows(before, after, declared);
    expect(drift.staleDeclarations).toEqual(expectedStale);
  });

  // WRITER ATTRIBUTION: the failure has to hand the reader the row, the table, the
  // bound that admitted it and what to do — the guard fires in the leaking test's
  // own teardown precisely so that this text lands on the culprit, and a message
  // that named only "a row moved" would waste that.
  it("the message names the table, the row, its bound and the fix", () => {
    const drift = diffSharedRows(
      snap(...SEEDED),
      snap(
        ...SEEDED.filter((r) => r.table !== "metric_samples"),
        sample(23, `${TODAY}|sleep_min|manual|a|b|450`)
      )
    );
    const message = sharedRowDriftMessage(drift, NOW);
    expect(message).toContain("metric_samples");
    expect(message).toContain("sleep_min");
    expect(message).toContain("ADDED");
    expect(message).toContain("REMOVED");
    expect(message).toContain(`on or after ${TODAY} (today onward)`);
    expect(message).toContain("sharedDayRestorePoint");
    // And it says what it did NOT repair, rather than implying the day is whole.
    expect(message).toContain("have NOT been put back");
    // A neighbour that did not move earns no section.
    expect(message).not.toContain("mood_logs");
  });

  // The horizon is a pure function of the instant it is handed, so a run at any hour
  // of any day watches the same window back from ITS OWN frozen clock. Reading the
  // wall clock here would make the guard behave differently depending on when CI ran,
  // which is the defect it exists to catch.
  it.each([
    ["2026-08-29T05:12:00.000Z", "2026-06-06"],
    ["2026-01-01T23:59:00.000Z", "2025-10-09"],
  ])("the activity horizon start for %s is %s", (instant, expected) => {
    expect(recencyHorizonStart(new Date(instant))).toBe(expected);
    expect(SHARED_RECENCY_HORIZON_DAYS).toBe(84);
  });

  it("the day-keyed tables are bounded at the frozen instant's own day", () => {
    for (const watched of WATCHED_SHARED_TABLES.filter(
      (w) => w.horizonDays === 0
    ))
      expect([watched.table, horizonStart(NOW, watched.horizonDays)]).toEqual([
        watched.table,
        TODAY,
      ]);
  });
});
