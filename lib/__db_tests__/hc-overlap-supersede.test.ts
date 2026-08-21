// DB INTEGRATION TIER — the overlap-supersede at ingest (#3424).
//
// WHAT IS BEING GUARDED. `upsertMetricSamples` now DELETES stored rows: a Health
// Connect interval whose window overlaps a stored one replaces it. That is the only
// path in the app where a sync removes a health reading it did not create in the same
// call, so the tests here are written for an adversary, not for coverage. Every guard
// that stands between this rule and someone's data has a case that goes RED when that
// guard alone is removed, and each says which:
//
//   • the source gate            → Withings / Oura / Strava / manual rows are never touched
//   • the non-degenerate window  → point readings (HRV) are never touched
//   • the shared-boundary test   → disjoint sub-daily buckets are never touched
//   • the #133 edit lock         → a hand-corrected row survives and is counted `edited`
//   • the #508 tombstone         → a user-deleted row stays dead
//   • the freshness comparison   → the CURRENT anchoring survives, not the last arrival
//   • the day radius             → the SQL narrowing agrees with the pure predicate
//
// SYNTHETIC ONLY: fictional profiles, invented step counts, no PHI.

import { beforeAll, describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  upsertMetricSamples,
  type NormMetricSample,
} from "@/lib/integrations/normalize";
import { emptyCounts } from "@/lib/integrations/sync-log";
import { writeImportTombstone } from "@/lib/integrations/tombstones";
import { metricSampleTombstoneKey } from "@/lib/integrations/tombstone-keys";
import {
  planSupersede,
  supersedeDateRange,
  type MetricWindow,
} from "@/lib/metric-window-overlap";

const HC = "health-connect";
const ORIGIN = "com.fitbit.FitbitMobile";

let profileId: number;

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run("HC OVERLAP")
      .lastInsertRowid
  );
});

/** A fresh profile, so one test's rows can never explain another's survival. */
function freshProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function sample(
  metric: string,
  date: string,
  started_at: string,
  ended_at: string,
  value: number,
  origin: string | null = ORIGIN
): NormMetricSample {
  return { metric, date, started_at, ended_at, value, origin };
}

function storedRows(
  profile: number,
  metric: string
): { source: string; started_at: string; ended_at: string; value: number }[] {
  return db
    .prepare(
      `SELECT source, started_at, ended_at, value FROM metric_samples
        WHERE profile_id = ? AND metric = ?
        ORDER BY source, started_at`
    )
    .all(profile, metric) as {
    source: string;
    started_at: string;
    ended_at: string;
    value: number;
  }[];
}

describe("the westward switch the prod incident and the repro both describe", () => {
  it("keeps the current anchoring and drops the re-anchored duplicate", () => {
    const p = freshProfile("WEST");
    // Push 1, device on Tokyo time: the Tokyo day bucket, 3000 steps so far.
    upsertMetricSamples(
      p,
      [
        sample(
          "steps",
          "2026-05-02",
          "2026-05-01T15:00:00Z",
          "2026-05-01T23:00:00Z",
          3000
        ),
      ],
      HC
    );
    // Push 2, device now on Honolulu time. The rolling window re-sends the Tokyo
    // record AND the re-anchored Honolulu day bucket that re-contains it.
    const counts = upsertMetricSamples(
      p,
      [
        sample(
          "steps",
          "2026-05-01",
          "2026-05-01T15:00:00Z",
          "2026-05-01T23:00:00Z",
          3000
        ),
        sample(
          "steps",
          "2026-05-01",
          "2026-05-01T10:00:00Z",
          "2026-05-02T01:00:00Z",
          3500
        ),
      ],
      HC
    );

    expect(storedRows(p, "steps")).toEqual([
      {
        source: HC,
        started_at: "2026-05-01T10:00:00Z",
        ended_at: "2026-05-02T01:00:00Z",
        value: 3500,
      },
    ]);
    // THE SUPERSEDE IS VISIBLE. Review has to be able to show that a stored row was
    // deleted; a silent delete is the failure this segment exists to prevent (#3424).
    expect(counts.superseded).toBe(1);
  });

  it("gets there from EITHER batch order — freshness, not arrival, decides", () => {
    // MUTATION: make the incoming row always win and the reversed order below stores
    // the stale 3000-step Tokyo record instead. That is the bug the ascending sort
    // was originally supposed to fix and could not.
    const p = freshProfile("WEST-REVERSED");
    upsertMetricSamples(
      p,
      [
        sample(
          "steps",
          "2026-05-02",
          "2026-05-01T15:00:00Z",
          "2026-05-01T23:00:00Z",
          3000
        ),
      ],
      HC
    );
    upsertMetricSamples(
      p,
      [
        sample(
          "steps",
          "2026-05-01",
          "2026-05-01T10:00:00Z",
          "2026-05-02T01:00:00Z",
          3500
        ),
        sample(
          "steps",
          "2026-05-02",
          "2026-05-01T15:00:00Z",
          "2026-05-01T23:00:00Z",
          3000
        ),
      ],
      HC
    );
    expect(storedRows(p, "steps").map((r) => r.value)).toEqual([3500]);
  });
});

describe("the eastward switch, including a re-anchored HISTORICAL day bucket", () => {
  it("leaves every window in the group pairwise disjoint", () => {
    const p = freshProfile("EAST");
    // Two New-York-anchored day buckets already stored (04:00Z is NY midnight).
    upsertMetricSamples(
      p,
      [
        sample(
          "steps",
          "2026-08-19",
          "2026-08-19T04:00:00Z",
          "2026-08-20T04:00:00Z",
          9000
        ),
        sample(
          "steps",
          "2026-08-20",
          "2026-08-20T04:00:00Z",
          "2026-08-20T18:00:00Z",
          11609
        ),
      ],
      HC
    );
    // Device flies NY → Tokyo. Tokyo midnight is 15:00Z the day before, so BOTH the
    // current bucket and the previous day's re-anchored one arrive re-cut.
    upsertMetricSamples(
      p,
      [
        sample(
          "steps",
          "2026-08-19",
          "2026-08-18T15:00:00Z",
          "2026-08-19T15:00:00Z",
          8700
        ),
        sample(
          "steps",
          "2026-08-20",
          "2026-08-19T15:00:00Z",
          "2026-08-20T15:00:00Z",
          9400
        ),
        sample(
          "steps",
          "2026-08-21",
          "2026-08-20T15:00:00Z",
          "2026-08-20T22:00:00Z",
          2100
        ),
      ],
      HC
    );

    const rows = storedRows(p, "steps");
    for (let i = 1; i < rows.length; i++) {
      expect(
        rows[i].started_at >= rows[i - 1].ended_at,
        `windows must be pairwise disjoint, got ${JSON.stringify(rows)}`
      ).toBe(true);
    }
    // No New-York-anchored row survived to double count into a Tokyo day.
    expect(rows.map((r) => r.started_at)).toEqual([
      "2026-08-18T15:00:00Z",
      "2026-08-19T15:00:00Z",
      "2026-08-20T15:00:00Z",
    ]);
  });
});

describe("what the rule must NEVER delete", () => {
  it("leaves other sources' overlapping rows alone", () => {
    // MUTATION: drop the `source === health-connect` gate and this goes red for all
    // four. These sources attribute on their own clock; nothing re-anchors under them.
    const p = freshProfile("OTHER-SOURCES");
    const morning = sample(
      "steps",
      "2026-05-01",
      "2026-05-01T04:00:00Z",
      "2026-05-01T12:00:00Z",
      2000,
      null
    );
    for (const src of ["withings", "oura", "strava", "manual"]) {
      upsertMetricSamples(p, [morning], src);
      // A second, OVERLAPPING window from the same source: under the supersede rule
      // this would delete the first. It must not, because the rule is not theirs.
      upsertMetricSamples(
        p,
        [
          sample(
            "steps",
            "2026-05-01",
            "2026-05-01T00:00:00Z",
            "2026-05-01T23:00:00Z",
            9000,
            null
          ),
        ],
        src
      );
    }
    const bySource = storedRows(p, "steps");
    expect(bySource).toHaveLength(8);
    for (const src of ["withings", "oura", "strava", "manual"]) {
      expect(bySource.filter((r) => r.source === src)).toHaveLength(2);
    }
  });

  it("leaves a Health Connect row of ANOTHER origin alone", () => {
    const p = freshProfile("OTHER-ORIGIN");
    upsertMetricSamples(
      p,
      [
        sample(
          "steps",
          "2026-05-01",
          "2026-05-01T04:00:00Z",
          "2026-05-01T20:00:00Z",
          5000,
          "com.google.android.apps.fitness"
        ),
      ],
      HC
    );
    upsertMetricSamples(
      p,
      [
        sample(
          "steps",
          "2026-05-01",
          "2026-05-01T07:00:00Z",
          "2026-05-01T23:00:00Z",
          5200,
          ORIGIN
        ),
      ],
      HC
    );
    expect(storedRows(p, "steps")).toHaveLength(2);
  });

  it("leaves DISJOINT sub-daily buckets alone, including back-to-back ones", () => {
    // MUTATION: make the boundary test inclusive (`<=`) and 23 of these 24 rows die.
    // A fine-grained exporter setting is a supported configuration (#1065).
    const p = freshProfile("FINE-GRAINED");
    const hourly = Array.from({ length: 24 }, (_, h) =>
      sample(
        "steps",
        "2026-05-01",
        `2026-05-01T${String(h).padStart(2, "0")}:00:00Z`,
        `2026-05-01T${String(h + 1).padStart(2, "0")}:00:00Z`,
        100 + h
      )
    );
    const counts = upsertMetricSamples(p, hourly, HC);
    expect(counts.superseded).toBe(0);
    expect(storedRows(p, "steps")).toHaveLength(24);
    // And a re-send of the same window is still an idempotent no-op.
    const again = upsertMetricSamples(p, hourly, HC);
    expect(again.superseded).toBe(0);
    expect(again.unchanged).toBe(24);
    expect(storedRows(p, "steps")).toHaveLength(24);
  });

  it("leaves POINT readings alone even when a day bucket spans them", () => {
    // MUTATION: drop the zero-length-window guard and the HRV readings vanish under
    // the daily bucket that merely contains them.
    const p = freshProfile("POINTS");
    const points = ["06:00", "07:00", "08:00"].map((hhmm) =>
      sample(
        "hrv_ms",
        "2026-05-01",
        `2026-05-01T${hhmm}:00Z`,
        `2026-05-01T${hhmm}:00Z`,
        40
      )
    );
    upsertMetricSamples(p, points, HC);
    // A same-metric INTERVAL spanning all three. Contrived — the parser never emits
    // one for hrv_ms — precisely so the guard is tested rather than assumed.
    const counts = upsertMetricSamples(
      p,
      [
        sample(
          "hrv_ms",
          "2026-05-01",
          "2026-05-01T00:00:00Z",
          "2026-05-02T00:00:00Z",
          44
        ),
      ],
      HC
    );
    expect(counts.superseded).toBe(0);
    expect(storedRows(p, "hrv_ms")).toHaveLength(4);
  });

  it("holds an EDIT-LOCKED overlapped row and counts it `edited`", () => {
    const p = freshProfile("LOCKED");
    upsertMetricSamples(
      p,
      [
        sample(
          "steps",
          "2026-05-02",
          "2026-05-01T15:00:00Z",
          "2026-05-01T23:00:00Z",
          3000
        ),
      ],
      HC
    );
    db.prepare(
      "UPDATE metric_samples SET edited = 1 WHERE profile_id = ? AND started_at = ?"
    ).run(p, "2026-05-01T15:00:00Z");

    const counts = upsertMetricSamples(
      p,
      [
        sample(
          "steps",
          "2026-05-01",
          "2026-05-01T10:00:00Z",
          "2026-05-02T01:00:00Z",
          3500
        ),
      ],
      HC
    );
    expect(counts.superseded).toBe(0);
    expect(counts.edited).toBe(1);
    // The hand-corrected row is still there, with its hand-corrected value.
    expect(storedRows(p, "steps").map((r) => r.value).sort()).toEqual([
      3000, 3500,
    ]);
  });

  it("counts one held lock ONCE however many incoming rows overlap it", () => {
    const p = freshProfile("LOCKED-ONCE");
    upsertMetricSamples(
      p,
      [
        sample(
          "steps",
          "2026-05-01",
          "2026-05-01T00:00:00Z",
          "2026-05-01T23:00:00Z",
          9000
        ),
      ],
      HC
    );
    db.prepare("UPDATE metric_samples SET edited = 1 WHERE profile_id = ?").run(p);
    const counts = upsertMetricSamples(
      p,
      [
        sample(
          "steps",
          "2026-05-01",
          "2026-05-01T02:00:00Z",
          "2026-05-01T06:00:00Z",
          100
        ),
        sample(
          "steps",
          "2026-05-01",
          "2026-05-01T06:00:00Z",
          "2026-05-01T10:00:00Z",
          200
        ),
      ],
      HC
    );
    expect(counts.edited).toBe(1);
  });

  it("keeps a TOMBSTONED row dead — a supersede is not a resurrection", () => {
    const p = freshProfile("TOMBSTONE");
    const key = metricSampleTombstoneKey(
      "steps",
      HC,
      ORIGIN,
      "2026-05-01T15:00:00Z"
    );
    writeImportTombstone(p, "metric_samples", key);
    const counts = upsertMetricSamples(
      p,
      [
        sample(
          "steps",
          "2026-05-01",
          "2026-05-01T15:00:00Z",
          "2026-05-01T23:00:00Z",
          3000
        ),
        sample(
          "steps",
          "2026-05-01",
          "2026-05-01T10:00:00Z",
          "2026-05-02T01:00:00Z",
          3500
        ),
      ],
      HC
    );
    expect(counts.suppressed).toBe(1);
    expect(storedRows(p, "steps").map((r) => r.started_at)).toEqual([
      "2026-05-01T10:00:00Z",
    ]);
  });

  it("writes NO tombstone for a superseded row — the delete is sync-internal", () => {
    // The #608 precedent. A tombstone here would block the exporter from ever
    // re-sending that span under its current anchoring.
    const p = freshProfile("NO-TOMBSTONE");
    upsertMetricSamples(
      p,
      [
        sample(
          "steps",
          "2026-05-02",
          "2026-05-01T15:00:00Z",
          "2026-05-01T23:00:00Z",
          3000
        ),
      ],
      HC
    );
    upsertMetricSamples(
      p,
      [
        sample(
          "steps",
          "2026-05-01",
          "2026-05-01T10:00:00Z",
          "2026-05-02T01:00:00Z",
          3500
        ),
      ],
      HC
    );
    const tombstones = db
      .prepare(
        "SELECT COUNT(*) AS n FROM import_tombstones WHERE profile_id = ? AND target_table = 'metric_samples'"
      )
      .get(p) as { n: number };
    expect(tombstones.n).toBe(0);
  });
});

describe("the SQL narrowing agrees with the pure rule", () => {
  // TWO ENCODINGS, PINNED — the planSyncEventPrune discipline. Ingest narrows
  // candidates with SQL (indexed prefix + day radius + `started_at <> ?`) and decides
  // with lib/metric-window-overlap.ts. If the narrowing ever excluded a row the
  // predicate would have superseded, the rule would quietly stop working on that shape.
  it("never narrows away a row the predicate would have superseded", () => {
    const p = freshProfile("PINNED");
    const stored: NormMetricSample[] = [];
    // A fortnight of day buckets under one anchoring, plus a point reading a day.
    for (let d = 10; d <= 24; d++) {
      const day = `2026-05-${String(d).padStart(2, "0")}`;
      const next = `2026-05-${String(d + 1).padStart(2, "0")}`;
      stored.push(
        sample("steps", day, `${day}T04:00:00Z`, `${next}T04:00:00Z`, 1000 + d)
      );
    }
    upsertMetricSamples(p, stored, HC);

    const incoming = sample(
      "steps",
      "2026-05-17",
      "2026-05-17T07:00:00Z",
      "2026-05-18T07:00:00Z",
      5555
    );
    // What the pure rule says about the WHOLE stored group, unnarrowed.
    const all = db
      .prepare(
        `SELECT id, date, started_at, ended_at, edited FROM metric_samples
          WHERE profile_id = ? AND metric = 'steps' AND source = ?
            AND started_at <> ?
          ORDER BY id`
      )
      .all(p, HC, incoming.started_at) as MetricWindow[];
    const unnarrowed = planSupersede(incoming, all);

    // What the SQL narrowing hands the rule.
    const { from, to } = supersedeDateRange(incoming.date);
    const narrowed = all.filter((r) => r.date >= from && r.date <= to);
    const viaNarrowing = planSupersede(incoming, narrowed);

    expect(viaNarrowing.supersede.map((r) => r.id)).toEqual(
      unnarrowed.supersede.map((r) => r.id)
    );
    expect(unnarrowed.supersede.length).toBeGreaterThan(0);
    // The narrowing genuinely narrows — otherwise the agreement above is vacuous.
    expect(narrowed.length).toBeLessThan(all.length);

    // And the real ingest deletes exactly that set.
    const counts = upsertMetricSamples(p, [incoming], HC);
    expect(counts.superseded).toBe(unnarrowed.supersede.length);
  });
});

describe("the accounting contract", () => {
  it("keeps `superseded` out of `received` — it is not a row the source sent", () => {
    const p = freshProfile("ACCOUNTING");
    upsertMetricSamples(
      p,
      [
        sample(
          "steps",
          "2026-05-02",
          "2026-05-01T15:00:00Z",
          "2026-05-01T23:00:00Z",
          3000
        ),
      ],
      HC
    );
    const counts = upsertMetricSamples(
      p,
      [
        sample(
          "steps",
          "2026-05-01",
          "2026-05-01T10:00:00Z",
          "2026-05-02T01:00:00Z",
          3500
        ),
      ],
      HC
    );
    expect(counts.superseded).toBe(1);
    expect(
      counts.inserted + counts.updated + counts.unchanged + counts.edited
    ).toBe(1);
  });

  it("starts every batch at zero", () => {
    expect(emptyCounts().superseded).toBe(0);
    const p = freshProfile("ZERO");
    expect(
      upsertMetricSamples(
        p,
        [
          sample(
            "steps",
            "2026-05-01",
            "2026-05-01T04:00:00Z",
            "2026-05-02T04:00:00Z",
            1
          ),
        ],
        HC
      ).superseded
    ).toBe(0);
  });

  it("does not disturb the shared profile's unrelated rows", () => {
    // Profile scoping, the plainest form: a same-metric, same-origin, OVERLAPPING
    // window on another profile must survive.
    const other = freshProfile("SCOPING-NEIGHBOUR");
    upsertMetricSamples(
      other,
      [
        sample(
          "steps",
          "2026-05-01",
          "2026-05-01T00:00:00Z",
          "2026-05-02T00:00:00Z",
          7777
        ),
      ],
      HC
    );
    upsertMetricSamples(
      profileId,
      [
        sample(
          "steps",
          "2026-05-01",
          "2026-05-01T03:00:00Z",
          "2026-05-02T03:00:00Z",
          8888
        ),
      ],
      HC
    );
    expect(storedRows(other, "steps").map((r) => r.value)).toEqual([7777]);
  });
});
