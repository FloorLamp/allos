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
  metricSampleUpsertReport,
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
import { ingestHealthConnectPayload } from "@/lib/integrations/health-connect-ingest";
import type { ParsedPayload } from "@/lib/integrations/health-connect";

const HC = "health-connect";
const ORIGIN = "com.fitbit.FitbitMobile";

let profileId: number;

beforeAll(() => {
  profileId = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run("HC OVERLAP")
      .lastInsertRowid
  );
});

// EVERY CALL IN THIS FILE IS A LATER PUSH THAN THE ONE BEFORE IT, which is what the
// ingest route always supplies and what the supersede now requires: a stamp the PAYLOAD
// stated. `upsertMetricSamples` deletes nothing without one — deliberately, because the
// version that derived freshness from the rows' own `ended_at` was measured dropping a
// correcting reading and reporting "nothing new" (see lib/metric-window-overlap.ts).
const PUSH_BASE = Date.parse("2026-09-01T00:00:00Z");
let pushSeq = 0;
function upsert(
  profile: number,
  rows: NormMetricSample[],
  source: string,
  sink?: Parameters<typeof upsertMetricSamples>[3],
  options: Parameters<typeof upsertMetricSamples>[4] = {}
) {
  pushSeq += 1;
  return upsertMetricSamples(profile, rows, source, sink, {
    pushedAt:
      new Date(PUSH_BASE + pushSeq * 60_000).toISOString().slice(0, 19) + "Z",
    ...options,
  });
}

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
  // WHAT CHANGED HERE, AND WHY IT IS NOT A REGRESSION IN THE RULE. #3424's repro puts
  // the re-sent pre-switch record and the re-anchored one in the SAME push, and two
  // earlier versions of this code picked a winner between them. Neither could justify
  // the choice: the stamp is per-PUSH so both rows carry the same one, and ranking by
  // `ended_at` is the window comparison lib/metric-window-overlap.ts's header spends a
  // page explaining is invalid on exactly this pair — it stored 3000 for 3500 walked.
  // There is no third source of evidence in a push: 306 captured payloads, 964 additive
  // records, and a record carries `start_time`, `end_time`, its value and
  // `metadata.data_origin`. Nothing else.
  //
  // So a push carrying both anchorings stores both, the day reads HIGH, Review says so,
  // and the next push whose stamp is newer collapses it. Reading high is visible and
  // repairable; the alternative was a reading that vanished.
  it("stores both when one push carries both anchorings, and says so", () => {
    const p = freshProfile("WEST");
    // Push 1, device on Tokyo time: the Tokyo day bucket, 3000 steps so far.
    upsert(
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
    const counts = upsert(
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
    expect(storedRows(p, "steps").map((r) => r.value)).toEqual([3500, 3000]);
    // ONE delete DID happen, and it is the legitimate one: the Honolulu row replaced
    // push 1's STORED Tokyo row, whose stamp is older. What did not happen is a delete
    // between the two rows of THIS push — they share a stamp, so the re-sent Tokyo
    // record is simply written back, and counted as an overlap left standing.
    // MUTATION: any within-push ranking makes one of these two rows disappear on a
    // basis that cannot be defended.
    expect(counts.superseded).toBe(1);
  });

  it("collapses to the walked count on the next push", () => {
    const p = freshProfile("WEST-CONVERGES");
    upsert(
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
    upsert(
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
    // Push 3 carries only the current anchoring, grown to the new push moment. It is
    // newer than everything stored, so it takes the stale row with it.
    const third = upsert(
      p,
      [
        sample(
          "steps",
          "2026-05-01",
          "2026-05-01T10:00:00Z",
          "2026-05-02T05:00:00Z",
          3800
        ),
      ],
      HC
    );
    expect(third.superseded).toBe(1);
    expect(storedRows(p, "steps").map((r) => r.value)).toEqual([3800]);
  });
});

describe("the eastward switch, including a re-anchored HISTORICAL day bucket", () => {
  it("leaves every window in the group pairwise disjoint", () => {
    const p = freshProfile("EAST");
    // Two New-York-anchored day buckets already stored (04:00Z is NY midnight).
    upsert(
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
    upsert(
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
      upsert(p, [morning], src);
      // A second, OVERLAPPING window from the same source: under the supersede rule
      // this would delete the first. It must not, because the rule is not theirs.
      upsert(
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
    upsert(
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
    upsert(
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
    const counts = upsert(p, hourly, HC);
    expect(counts.superseded).toBe(0);
    expect(storedRows(p, "steps")).toHaveLength(24);
    // And a re-send of the same window is still an idempotent no-op.
    const again = upsert(p, hourly, HC);
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
    upsert(p, points, HC);
    // A same-metric INTERVAL spanning all three. Contrived — the parser never emits
    // one for hrv_ms — precisely so the guard is tested rather than assumed.
    const counts = upsert(
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

  // WHAT CHANGED, AND WHY IT IS NOT A LOSS OF VISIBILITY. #3424's AC 4 asks for the
  // held row to be "counted `edited`". It cannot be, and `lib/integrations/sync-log.ts`
  // says why in its own words: `edited` IS part of `received`, and `received` is
  // "everything the source handed us". A held overlap is a row OUR STORE already had —
  // the source did not send it — so counting it made a one-sample payload report
  // `received: 2`, which is a number the sender can check and would find wrong.
  //
  // The lock stays visible through the channel that was built for exactly this: the
  // count of overlaps LEFT STANDING, whose Review line already names the #133 lock as
  // one of the four reasons a day still double counts. Nothing is quieter than before;
  // it is reported as what it is.
  it("holds an EDIT-LOCKED overlapped row, and reports it as a day left double counting", () => {
    const p = freshProfile("LOCKED");
    upsert(
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

    const counts = upsert(
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
    // MUTATION: count the held row into `edited` again and `received` reads 2 for a
    // 1-sample payload (lib/__tests__/sync-log.test.ts pins the arithmetic).
    expect(counts.edited).toBe(0);
    expect(metricSampleUpsertReport(counts)?.overlapsLeftStanding).toBe(1);
    // The hand-corrected row is still there, with its hand-corrected value.
    expect(
      storedRows(p, "steps")
        .map((r) => r.value)
        .sort()
    ).toEqual([3000, 3500]);
  });

  it("counts one stored row left standing ONCE however many incoming rows overlap it", () => {
    const p = freshProfile("LOCKED-ONCE");
    upsert(
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
    db.prepare("UPDATE metric_samples SET edited = 1 WHERE profile_id = ?").run(
      p
    );
    const counts = upsert(
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
    // MUTATION: drop the Set and count PAIRS again — the Review line says "2 daily
    // totals" for ONE day that reads wrong. Verified red as zzr6-attack A5a.
    expect(metricSampleUpsertReport(counts)?.overlapsLeftStanding).toBe(1);
    expect(counts.edited).toBe(0);
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
    const counts = upsert(
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

  // WHAT USED TO STAND HERE, AND WHY IT DID NOT. This case was guarded by `!staleRetry`
  // — `isStaleMetricSnapshot(found.ended_at, r.ended_at)`, an `ended_at` comparison,
  // which lib/metric-window-overlap.ts's own header spends a page explaining cannot
  // decide which of two ANCHORINGS is current. It was also STRICT, so it only ever fired
  // for a retry whose window is a strict PREFIX. Change the fixture's `end_time` below
  // from 18:00 to the stored twin's 20:00 — a byte-identical replay, the ordinary shape
  // when a phone queues pushes offline in flight — and the guard was walked straight
  // through and the Los Angeles row deleted.
  //
  // The stamp is what answers this. `!staleRetry` is gone from the supersede condition
  // and stays where #1101 put it: the moving-END merge for the natural-key twin. The
  // three cases below are the same store under a prefix retry, a byte-identical replay,
  // and a retry that ends LATER — one rule, one answer.
  it.each([
    [
      "a PREFIX retry, ending earlier than the stored twin",
      "2026-08-20T18:00:00Z",
      9000,
    ],
    [
      "a BYTE-IDENTICAL replay of the pre-switch push",
      "2026-08-20T20:00:00Z",
      11609,
    ],
    [
      "a retry ending LATER than the stored twin",
      "2026-08-20T22:00:00Z",
      11800,
    ],
  ])(
    "lets %s delete nothing — it carries the old anchoring",
    (_name, endedAt, value) => {
      // The one shape where this is reachable: a store that has NOT converged yet.
      // Once ingest has run the group is pairwise disjoint, a stale retry's window is a
      // strict PREFIX of its own stored twin's, and the only stored row it could overlap
      // is that twin — which the candidate SELECT already excludes. But an
      // ALREADY-CORRUPTED profile (the prod shape, before the repair migration or the
      // first re-anchored push) holds both anchorings at once, and there a retry of the
      // OLD snapshot overlaps the NEW anchoring's row.
      const p = freshProfile("STALE-RETRY");
      db.prepare(
        `INSERT INTO metric_samples
         (profile_id, source, origin, metric, date, started_at, ended_at, value)
       VALUES (?, ?, ?, 'steps', '2026-08-20', ?, ?, ?)`
      ).run(
        p,
        HC,
        ORIGIN,
        "2026-08-20T04:00:00Z",
        "2026-08-20T20:00:00Z",
        11609
      );
      db.prepare(
        `INSERT INTO metric_samples
         (profile_id, source, origin, metric, date, started_at, ended_at, value)
       VALUES (?, ?, ?, 'steps', '2026-08-20', ?, ?, ?)`
      ).run(
        p,
        HC,
        ORIGIN,
        "2026-08-20T07:00:00Z",
        "2026-08-20T21:00:00Z",
        11721
      );

      // A push that got queued BEFORE the switch and only arrives now: the New York
      // snapshot, ending EARLIER than the row already stored under its own key.
      const counts = upsert(
        p,
        [sample("steps", "2026-08-20", "2026-08-20T04:00:00Z", endedAt, value)],
        HC
      );
      // Both rows carry NULL, and both were written AFTER the era the migration recorded
      // — so nothing here is a row this rule has any evidence about, and it takes none of
      // them. MUTATION: read a NULL stamp as "older than everything" again and the Los
      // Angeles row — the CURRENT anchoring — is deleted by a snapshot the source has
      // already moved past. Verified red as zzr6-staleretry E2/E3.
      expect(counts.superseded).toBe(0);
      // BOTH anchorings survive. The retry's own natural-key TWIN is a different question
      // — #1101's moving-END merge owns it, and in the third case it legitimately updates
      // that row's value — but the row holding the CURRENT anchoring is untouched.
      expect(storedRows(p, "steps").map((r) => r.started_at)).toEqual([
        "2026-08-20T04:00:00Z",
        "2026-08-20T07:00:00Z",
      ]);
      expect(
        storedRows(p, "steps").find(
          (r) => r.started_at === "2026-08-20T07:00:00Z"
        )?.value
      ).toBe(11721);
    }
  );

  it("reports a stored SUB-DAILY bucket it may never collapse, instead of nothing", () => {
    // A genuine `daily` bucket pushed 20 minutes after local midnight is itself below
    // the granularity gate, and no later push ever widens a row already in the table —
    // so this day reads high until #3439 replays the rule over history. It used to do
    // that with `superseded: 0`, `warnings: []` and no other trace.
    // MUTATION: `continue` past this row without counting it and the day reads 9200 for
    // 9000 walked with nothing said. Verified red as zzr6-attack A3a.
    const p = freshProfile("SHORT-STORED");
    upsert(
      p,
      [
        sample(
          "steps",
          "2026-05-01",
          "2026-05-01T04:00:00Z",
          "2026-05-01T04:20:00Z",
          200
        ),
      ],
      HC
    );
    let counts = upsert(
      p,
      [
        sample(
          "steps",
          "2026-05-01",
          "2026-04-30T15:00:00Z",
          "2026-05-01T09:00:00Z",
          9000
        ),
      ],
      HC
    );
    expect(counts.superseded).toBe(0);
    expect(metricSampleUpsertReport(counts)?.overlapsLeftStanding).toBe(1);
    // And it is still reported on the NEXT push, because nothing repaired it.
    counts = upsert(
      p,
      [
        sample(
          "steps",
          "2026-05-01",
          "2026-04-30T15:00:00Z",
          "2026-05-01T13:00:00Z",
          9000
        ),
      ],
      HC
    );
    expect(metricSampleUpsertReport(counts)?.overlapsLeftStanding).toBe(1);
    expect(storedRows(p, "steps").map((r) => r.value)).toEqual([9000, 200]);
  });

  it("writes NO tombstone for a superseded row — the delete is sync-internal", () => {
    // The #608 precedent. A tombstone here would block the exporter from ever
    // re-sending that span under its current anchoring.
    const p = freshProfile("NO-TOMBSTONE");
    upsert(
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
    upsert(
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
    upsert(p, stored, HC);

    const incoming = sample(
      "steps",
      "2026-05-17",
      "2026-05-17T07:00:00Z",
      "2026-05-18T07:00:00Z",
      5555
    );
    // Stated explicitly here only so the hand-run predicate below and the real ingest
    // call at the end of the test compare against the SAME push.
    const PUSHED_AT = "2027-01-01T00:00:00Z";
    const withStamp = { ...incoming, pushedAt: PUSHED_AT };
    // What the pure rule says about the WHOLE stored group, unnarrowed.
    const all = db
      .prepare(
        `SELECT id, date, started_at, ended_at, edited, pushed_at FROM metric_samples
          WHERE profile_id = ? AND metric = 'steps' AND source = ?
            AND started_at <> ?
          ORDER BY id`
      )
      .all(p, HC, incoming.started_at) as MetricWindow[];
    const unnarrowed = planSupersede(withStamp, all);

    // What the SQL narrowing hands the rule.
    const { from, to } = supersedeDateRange(incoming.date);
    const narrowed = all.filter((r) => r.date >= from && r.date <= to);
    const viaNarrowing = planSupersede(withStamp, narrowed);

    expect(viaNarrowing.supersede.map((r) => r.id)).toEqual(
      unnarrowed.supersede.map((r) => r.id)
    );
    expect(unnarrowed.supersede.length).toBeGreaterThan(0);
    // The narrowing genuinely narrows — otherwise the agreement above is vacuous.
    expect(narrowed.length).toBeLessThan(all.length);

    // And the real ingest deletes exactly that set.
    const counts = upsert(p, [incoming], HC, undefined, {
      pushedAt: PUSHED_AT,
    });
    expect(counts.superseded).toBe(unnarrowed.supersede.length);
  });
});

describe("the accounting contract", () => {
  it("keeps `superseded` out of `received` — it is not a row the source sent", () => {
    const p = freshProfile("ACCOUNTING");
    upsert(
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
    const counts = upsert(
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
      upsert(
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
    upsert(
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
    upsert(
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

describe("each batch is processed in ascending started_at order", () => {
  // DETERMINISTIC WRITE ORDER, not correctness. Every row of a push carries the same
  // `pushed_at` and a supersede requires a strictly OLDER stamp, so no row of a batch can
  // ever delete another and the survivor set is identical whatever order they are written
  // in — chunk boundaries included (owner ruling on #3424). The sort is kept so
  // `metric_samples.id` follows the day for anyone reading the table by hand, and that is
  // exactly why it needs its own pin: nothing about the STORE would notice it going.
  //
  // What IS observable is the order of the WRITES, and `metric_samples.id` records it:
  // rowids ascend with insertion, so a batch handed to us shuffled must still come out
  // of the table in started_at order when read by id.
  function insertOrder(profile: number): string[] {
    return (
      db
        .prepare(
          `SELECT started_at FROM metric_samples
            WHERE profile_id = ? AND metric = 'steps' ORDER BY id`
        )
        .all(profile) as { started_at: string }[]
    ).map((r) => r.started_at);
  }

  // Four DISJOINT sub-daily buckets — nothing here overlaps anything, so the supersede
  // never fires and the only thing under test is the order.
  const WINDOWS: [string, string][] = [
    ["2026-06-01T00:00:00Z", "2026-06-01T06:00:00Z"],
    ["2026-06-01T06:00:00Z", "2026-06-01T12:00:00Z"],
    ["2026-06-01T12:00:00Z", "2026-06-01T18:00:00Z"],
    ["2026-06-01T18:00:00Z", "2026-06-02T00:00:00Z"],
  ];
  const ASCENDING = WINDOWS.map(([start]) => start);

  it("orders a shuffled batch inside upsertMetricSamples", () => {
    const p = freshProfile("ORDER-UPSERT");
    // Handed to us newest-first, which is the order that loses a re-sent leading
    // sliver at the trailing edge of the rolling window.
    const shuffled = [...WINDOWS]
      .reverse()
      .map(([start, end], i) =>
        sample("steps", "2026-06-01", start, end, i + 1)
      );
    upsert(p, shuffled, HC);
    expect(insertOrder(p)).toEqual(ASCENDING);
  });

  it("orders the WHOLE payload before the chunk split, not just within a chunk", () => {
    // chunkSize 2 with four descending rows: sorting only inside upsertMetricSamples
    // would write [12:00, 18:00] then [00:00, 06:00] — each chunk internally ordered
    // and the batch as a whole still backwards. The sort in ingestHealthConnectPayload
    // is what makes the per-chunk order a global one.
    const p = freshProfile("ORDER-CHUNKED");
    const parsed: ParsedPayload = {
      bodyMetrics: [],
      samples: [...WINDOWS]
        .reverse()
        .map(([start, end], i) =>
          sample("steps", "2026-06-01", start, end, i + 1)
        ),
      hrMinutes: [],
      activities: [],
      vitals: [],
      skipped: 0,
      details: { warnings: [], origins: [] },
      pushedAt: null,
    };
    ingestHealthConnectPayload(p, parsed, HC, 2);
    expect(insertOrder(p)).toEqual(ASCENDING);
  });
});
