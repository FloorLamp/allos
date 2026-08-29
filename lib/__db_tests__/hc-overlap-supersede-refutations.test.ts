// DB INTEGRATION TIER — every shape that REFUTED the first cut of #3424's rule.
//
// The overlap-supersede is the only path in the app where a sync deletes a health
// reading it did not create in the same call. An adversarial review broke the first cut
// four separate ways, and each break ended with a deleted reading. The reproductions
// live here rather than in a scratchpad, because a refutation that is not in the tree is
// a refutation the next rewrite gets to make again.
//
// Each test is named for what it protects and carries the MUTATION that brings the
// defect back. They exercise the REAL ingest entry point, at the SHIPPED chunk size,
// through the REAL parser — the refutations turned on details (`dataOrigin` reading
// only `metadata.data_origin`, `chunk()` slicing at 1000) that a hand-built
// `NormMetricSample` fixture cannot see.
//
// SYNTHETIC ONLY: fictional profiles, invented counts, no PHI.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import {
  overlapsLeftWarning,
  parseHealthConnectPayload,
} from "@/lib/integrations/health-connect";
import { ingestHealthConnectPayload } from "@/lib/integrations/health-connect-ingest";
import {
  upsertMetricSamples,
  type NormMetricSample,
} from "@/lib/integrations/normalize";
import { updateReadingAt } from "@/lib/reading-writes";
import { pushMetricSamples } from "./hc-metric-sample-push";
import { pushStampFor } from "@/lib/metric-window-overlap";
import { writeImportTombstone } from "@/lib/integrations/tombstones";
import { metricSampleTombstoneKey } from "@/lib/integrations/tombstone-keys";

const HC = "health-connect";
const ORIGIN = "com.fitbit.FitbitMobile";

/**
 * The fragment `overlapsLeftWarning` states whatever the count is, so a case asserting
 * the line is ABSENT can match on it without knowing the number the line would carry.
 */
const OVERLAP_LINE = "overlap other readings on the same day";

/** A fresh profile per case, so one test's rows can never explain another's survival. */
function freshProfile(name: string): number {
  return Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
}

function warningsOf(_result: unknown): string[] {
  return lastParsedDetails?.warnings ?? [];
}

/** The details object of the most recent push, which the ingest appends its line to. */
let lastParsedDetails: { warnings: string[] } | null = null;

function stored(profile: number, metric: string) {
  return db
    .prepare(
      `SELECT started_at, ended_at, value FROM metric_samples
        WHERE profile_id = ? AND metric = ? ORDER BY started_at`
    )
    .all(profile, metric) as {
    started_at: string;
    ended_at: string;
    value: number;
  }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// THE INVARIANT THE COVER-THE-DAY RULING IS BUILT ON, ASSERTED OVER EVERY ATTACK IN
// THIS FILE (#3424, the ruling of 2026-08-23T00:58Z).
//
//     A DATE KEEPS A READING. No profile-local day that held a reading before a push
//     holds nothing after it.
//
// It is not one more example, and that is why it lives here rather than in a test of
// its own: round 10 emptied a day through THREE different doors — a tombstoned
// replacement, a #1101 stale retry, and the eastward trailing edge — and each looked
// like a different bug. They are one bug, and it is the one the `date` term closes:
// a victim on date D is deleted only because a row filed under D landed in this push,
// that row is in the store, and it can never itself be a victim (the candidate query
// excludes this push's own rows). So D is left holding at least the row that justified
// the delete.
//
// EVERY DOOR INTO THE INGEST IN THIS FILE GOES THROUGH `guarded`, so a case added later
// is covered without anyone remembering to cover it.
//
// `guarded` ENCODES THE STRICTER OF THE TWO READINGS: it compares (metric, date) totals
// with the ZEROES DROPPED, so a day whose total falls to 0 counts as emptied even though
// a row is still there. The ruling says "a date keeps a reading"; this says "a date keeps
// a NON-ZERO total". Nothing in this file reaches the gap — no fixture supersedes a
// non-zero row with a 0-valued bucket on its own date — and the stricter reading is the
// one worth failing on, because a day reading 0 is what the person sees.
//
// MUTATION — AND IT TAKES BOTH HALVES OF THE `date` TERM, not either. Measured over the
// three Health Connect supersede specs (79 tests) rather than asserted:
//
//   • `AND date = ?` out of `supersedeMetricSampleOverlaps`'s candidate query ALONE:
//     1 failed of 79, and the one is the QUERY PLAN assertion — hc-overlap-supersede.ts's
//     "resolves to the (profile_id, metric, date) index prefix, with no temp b-tree",
//     added this round for exactly this reason. Before it existed the run was EXIT=0 and
//     78 passed: not one behavioural case died. That term is the NARROWING, and a
//     narrowing is pinned by the plan it produces or by nothing.
//   • `row.date !== incoming.date` out of `planSupersede` ALONE: EXIT=1, 1 failed — and
//     it is NOT one of the drivers. It is hc-overlap-supersede.test.ts:837, "never
//     narrows away a row the predicate would have superseded", which hands the pure rule
//     the whole UNNARROWED stored group and so sees the term go missing from the one
//     encoding that decides.
//   • BOTH: EXIT=1, 5 failed — those two, plus all three round-10 drivers, each of them
//     here on `guarded`. Their own assertions catch it too: with `guarded` neutered the
//     same mutation still reds all three (3 failed of 48).
//
// So `planSupersede`'s term is the SAFETY encoding and the SQL's is the narrowing beside
// it. An earlier version of this note said "either", which was wrong in both directions.
//
// A PUSH THAT THROWS IS NOT CHECKED, deliberately: the transaction rolled back, there is
// nothing this could observe, and an assertion raised out of a `finally` would replace
// the error the chunk-failure cases exist to catch. Those cases assert the stronger
// commit-point invariant themselves (D1, below).

/** Every (metric, date) total this profile reads right now, with the zeroes dropped. */
function dayTotals(profile: number): Map<string, number> {
  const rows = db
    .prepare(
      `SELECT metric, date, SUM(value) AS total FROM metric_samples
        WHERE profile_id = ? GROUP BY metric, date`
    )
    .all(profile) as { metric: string; date: string; total: number }[];
  return new Map(
    rows
      .filter((r) => r.total !== 0)
      .map((r) => [`${r.metric} ${r.date}`, r.total])
  );
}

/** Run one push and assert it emptied no date. */
function guarded<T>(profile: number, run: () => T): T {
  const before = dayTotals(profile);
  const out = run();
  const after = dayTotals(profile);
  for (const [key, total] of before) {
    expect(
      after.has(key),
      `A DATE LOST ITS LAST READING: ${key} read ${total} before this push and reads nothing after it.`
    ).toBe(true);
  }
  return out;
}

function rowCount(profile: number, metric: string): number {
  return (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM metric_samples WHERE profile_id = ? AND metric = ?"
      )
      .get(profile, metric) as { n: number }
  ).n;
}

// EVERY REAL EXPORTER PUSH STATES `timestamp`, and the supersede now requires it —
// measured over the captured payloads: of 228 bodies, all 175 carrying an `app_version`
// (i.e. every real push) state a readable one. So these fixtures state one too, and a
// caller that wants to REPLAY a push passes that push's own stamp back.
//
// AND STATE ONE IN THE PAST (#3438). `pushStampFor` nulls a stated instant more than
// MAX_PUSH_CLOCK_SKEW_MS ahead of the server clock. This file used to date its pushes
// 2026-09-01, ten days after the day it was written, so every `push()` here — which goes
// through the REAL ingest — was running with `pushedAt: null` and superseding nothing:
// the "the rule declined" assertions below were passing for the wrong reason, and their
// stated MUTATIONS could not have gone red. The case at the end of this file pins it.
const PUSH_BASE = Date.parse("2026-08-21T18:00:00Z");
let pushSeq = 0;
const stampFor = (seq: number) =>
  new Date(PUSH_BASE + seq * 60_000).toISOString().slice(0, 19) + "Z";

/** A direct upsert whose batch is a LATER push than the one before it. */
function upsert(
  profile: number,
  rows: NormMetricSample[],
  source: string,
  sink?: Parameters<typeof upsertMetricSamples>[3],
  options: Parameters<typeof upsertMetricSamples>[4] = {}
) {
  pushSeq += 1;
  // The three passes the ingest runs, not `upsertMetricSamples` alone — the supersede
  // does not live in the upsert loop any more (#3424, owner ruling option 2).
  return guarded(profile, () =>
    pushMetricSamples(profile, rows, source, sink, {
      pushedAt: stampFor(pushSeq),
      ...options,
    })
  );
}
function push(
  profile: number,
  body: Record<string, unknown>,
  timestamp?: string
) {
  pushSeq += 1;
  const stamp = timestamp ?? stampFor(pushSeq);
  const parsed = parseHealthConnectPayload(
    { ...body, timestamp: stamp },
    "UTC"
  );
  lastParsedDetails = parsed.details;
  return guarded(profile, () => ingestHealthConnectPayload(profile, parsed));
}

// ─────────────────────────────────────────────────────────────────────────────
// R1 — the chunk split, at the SHIPPED default chunk size.
// ─────────────────────────────────────────────────────────────────────────────

/** 300 one-minute buckets in the 6 hours between the two anchorings. */
function oneMinuteBuckets(
  key: string,
  valueKey: string
): Record<string, unknown> {
  const out: Record<string, unknown>[] = [];
  const base = Date.UTC(2026, 4, 1, 4, 1, 0);
  for (let i = 0; i < 300; i++) {
    out.push({
      start_time: new Date(base + i * 60000).toISOString(),
      end_time: new Date(base + (i + 1) * 60000).toISOString(),
      [valueKey]: 3,
      metadata: { data_origin: ORIGIN },
    });
  }
  return { [key]: out };
}

describe("R1 — a push bigger than INGEST_CHUNK_SIZE", () => {
  // THE DEFECT. The first cut resolved a mixed-anchoring pair inside ONE PUSH with a
  // pass scoped to the CHUNK, defended by an arithmetic claim: "a `daily` push carries
  // a handful of interval rows per type against INGEST_CHUNK_SIZE = 1000". That is a
  // claim about payload COMPOSITION and the route does not enforce it —
  // MAX_INGEST_RECORDS is 100_000. With 1200 one-minute buckets sorting BETWEEN the two
  // anchorings, the pair straddled the 1000-row boundary, the pass never saw it, and
  // the per-row rule resolved it by arrival: the STALE 1800 kcal record deleted the
  // CURRENT 2400 one. Before the PR both rows survived — a visible, repairable double
  // count. After it, the correct row was gone.
  it("stores both anchorings and deletes nothing, at the shipped chunk size", () => {
    // THE ORIGINAL DEFECT: the pair straddled the 1000-row boundary, the batch-scoped
    // pass never saw it, and the per-row rule resolved it by ARRIVAL — the stale 1800
    // record deleting the current 2400 one. Both halves of that are now impossible: the
    // rows of one push share a stamp so neither can supersede the other, and there is no
    // within-push ranking left to depend on which chunk a row landed in.
    // TWO BARRIERS STAND BETWEEN THIS PUSH AND A DELETE, AND EITHER ONE ALONE HOLDS IT,
    // which is why no single mutation reds this case. Measured:
    //   • relax `pushOutranks` to `>=` (the equal-stamp barrier): the WHOLE db tier stays
    //     green, 6624 passed. The candidate query never hands `planSupersede` a row of
    //     this push, so the comparison is not even reached from here. What does catch it
    //     is the pure tier — lib/__tests__/metric-window-overlap.test.ts, "is FALSE on an
    //     equal stamp — a replay, or a second chunk of the same push" (1 failed of 47).
    //   • drop `AND pushed_at IS NOT ?` (the push-key exclusion): 17 tests red across the
    //     three HC specs, but not this one — both rows then see each other and the equal
    //     stamp still refuses the delete.
    // The redundancy is deliberate and this case records the RESULT of it; the two
    // barriers are pinned individually, above and in the pure tier.
    const p = freshProfile("R1-CHUNK");
    const result = push(
      p,
      {
        total_calories: [
          {
            start_time: "2026-05-01T04:00:00Z", // pre-switch anchoring
            end_time: "2026-05-01T23:00:00Z",
            calories: 1800,
            metadata: { data_origin: ORIGIN },
          },
          {
            start_time: "2026-05-01T10:00:00Z", // re-anchored, still filling
            end_time: "2026-05-02T01:00:00Z",
            calories: 2400,
            metadata: { data_origin: ORIGIN },
          },
        ],
        ...oneMinuteBuckets("steps", "count"),
        ...oneMinuteBuckets("distance", "meters"),
        ...oneMinuteBuckets("active_calories", "calories"),
        ...oneMinuteBuckets("hydration", "liters"),
      },
      "2026-05-02T01:00:05Z"
    );
    expect(result.split.superseded).toBe(0);
    expect(stored(p, "total_kcal").map((r) => r.value)).toEqual([1800, 2400]);
  });

  it("will not let one device's minute bucket delete another's", () => {
    // The 1200 buckets below are back-to-back and therefore DISJOINT, so they never
    // exercise the granularity gate. This does: two devices that set no
    // `metadata.data_origin` both parse to origin = null and share ONE supersede group,
    // and their minute buckets genuinely overlap.
    // MUTATION: drop `isDayBucketWindow` and the second push deletes the first row.
    const p = freshProfile("R1-NULL-ORIGIN-MINUTES");
    push(p, {
      steps: [
        {
          start_time: "2026-05-01T10:00:00Z",
          end_time: "2026-05-01T10:01:00Z",
          count: 40,
        },
      ],
    });
    const second = push(p, {
      steps: [
        {
          start_time: "2026-05-01T10:00:30Z",
          end_time: "2026-05-01T10:01:30Z",
          count: 55,
        },
      ],
    });
    expect(second.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([40, 55]);
  });

  it("leaves all 1200 sub-daily buckets standing", () => {
    // The granularity gate, at the scale a `1m` exporter actually produces.
    const p = freshProfile("R1-SUBDAILY");
    push(p, {
      ...oneMinuteBuckets("steps", "count"),
      ...oneMinuteBuckets("distance", "meters"),
      ...oneMinuteBuckets("active_calories", "calories"),
      ...oneMinuteBuckets("hydration", "liters"),
    });
    for (const metric of [
      "steps",
      "distance_km",
      "active_kcal",
      "hydration_l",
    ]) {
      expect(rowCount(p, metric)).toBe(300);
    }
  });

  it("says nothing when a `1m` push lands on a stored day bucket", () => {
    // THE GRANULARITY GATE ON THE JUSTIFIER SIDE IS A COST BOUND, AND THIS IS WHAT MAKES
    // IT OBSERVABLE. `supersedeMetricSampleOverlaps` only issues a candidate query for a
    // stamped row that clears `isSupersedingWindow`, so an 11.5k-row `1m` push does one
    // indexed lookup and stops instead of ~11.5k range queries. Safety does not depend on
    // it — `planSupersede` routes a fine-grained incoming window to `left` rather than
    // `supersede` either way — so nothing is deleted with or without it. What the filter
    // costs is the REPORT: a minute bucket landing on a stored day bucket IS a day
    // reading high, and it is deliberately not named, because naming it means one range
    // query per minute bucket.
    //
    // MUTATION: relax the filter to `isDayBucketMetric(row.metric)` and this warns.
    const p = freshProfile("R1-FINE-GRAINED-ON-DAY-BUCKET");
    push(
      p,
      {
        app_version: "1.9.14",
        steps: [steps("2026-05-01T00:00:00Z", "2026-05-02T00:00:00Z", 8000)],
      },
      "2026-05-02T01:00:00Z"
    );
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000]);
    const minutes = [];
    for (let i = 0; i < 5; i++)
      minutes.push(
        steps(
          new Date(Date.UTC(2026, 4, 1, 10, i)).toISOString().slice(0, 19) +
            "Z",
          new Date(Date.UTC(2026, 4, 1, 10, i + 1)).toISOString().slice(0, 19) +
            "Z",
          3
        )
      );
    const result = push(
      p,
      { app_version: "1.9.14", steps: minutes },
      "2026-05-02T02:00:00Z"
    );
    // The day bucket is untouched — a minute bucket may never collapse one.
    expect(result.split.superseded).toBe(0);
    expect(rowCount(p, "steps")).toBe(6);
    // The parser's own fine-grained-setting advice is a different line and is expected
    // here; the OVERLAP line is the one that must not fire.
    expect(warningsOf(result)).toEqual([
      expect.stringContaining("fine-grained setting"),
    ]);
    expect(warningsOf(result)).not.toContain(overlapsLeftWarning(1));
  });
});

/** One Health Connect steps record, origin-tagged the way `dataOrigin` actually reads. */
function steps(start: string, end: string, count: number) {
  return {
    start_time: start,
    end_time: end,
    count,
    metadata: { data_origin: ORIGIN },
  };
}

/** 300 one-minute buckets from a given UTC hour, for a metric OTHER than the pair's. */
function fillerBuckets(
  key: string,
  valueKey: string,
  year: number,
  monthIndex: number,
  day: number,
  hour: number
): Record<string, unknown> {
  const out: Record<string, unknown>[] = [];
  const base = Date.UTC(year, monthIndex, day, hour, 1, 0);
  for (let i = 0; i < 300; i++) {
    out.push({
      start_time: new Date(base + i * 60000).toISOString(),
      end_time: new Date(base + (i + 1) * 60000).toISOString(),
      [valueKey]: 3,
      metadata: { data_origin: ORIGIN },
    });
  }
  return { [key]: out };
}

describe("a push carrying BOTH anchorings leaves a double count, and converges", () => {
  // THERE IS NO WITHIN-PUSH RULE, and this is what that costs. #3424 says the rolling
  // window re-sends the pre-switch record ALONGSIDE the re-anchored one, so two earlier
  // versions had a first phase that picked a winner between two overlapping rows of ONE
  // push. Ask what evidence such a phase could use and there is none: the stamp is
  // per-PUSH so both rows carry the same one, and the ENDS are a window quantity that
  // lib/metric-window-overlap.ts's header spends a page explaining is invalid on exactly
  // this pair. The phase that ranked by ends stored 3000 for 3500 walked, and against an
  // already-converged store its kept stale row then superseded the correct one.
  //
  // Measured over the captured payloads before removing it: 306 pushes, 964 additive
  // records, 394 at day-bucket granularity, TWO distinct anchorings present in the
  // corpus (04:00Z and 00:00Z) — and NOT ONE push carrying two overlapping
  // same-(metric, origin) day buckets. A record carries `start_time`, `end_time`, its
  // value and `metadata.data_origin`: one metadata key, no id, no last-modified time,
  // no client record version, no device.
  //
  // So both rows are stored. The day reads HIGH — visible in every total, said out loud
  // in Review — and the next push whose stamp is newer collapses it.
  // BOTH BUCKETS NAME 2026-08-20, and since #3901 that is what makes them a double
  // count rather than two days' readings: the still-filling NEW YORK bucket for 08-20
  // (04:00Z is NY midnight) against the re-cut TOKYO bucket for the SAME local day,
  // which +9 anchors at 08-19T15:00Z and which completed when Tokyo's 08-20 ended. A
  // pair whose two anchorings named DIFFERENT days would not sum into one day at all,
  // so it is not the shape this describe is about.
  const NY = steps("2026-08-20T04:00:00Z", "2026-08-20T18:00:00Z", 9000);
  const TOKYO = steps("2026-08-19T15:00:00Z", "2026-08-20T15:00:00Z", 11000);

  // SEEDED, NOT FRESH — and that is the correction the owner's ruling made explicit.
  // Every earlier version of these three cases pushed into an EMPTY store, where ruling
  // item 3 does no work at all: with nothing stored, "both are written" is what an
  // ordinary insert does, and five review rounds could each read that green as proof the
  // rule held. The configuration item 3 actually governs is a mixed-anchoring push
  // against a store that ALREADY HOLDS ONE OF THE TWO — where the re-sent row is both a
  // row the push will upsert and a row the push's other bucket outranks and overlaps.
  const seedNY = (p: number) =>
    push(p, { steps: [NY] }, "2026-08-21T05:00:05Z");

  it("stores both, says so, and deletes nothing", () => {
    // MUTATION: drop the `AND pushed_at IS NOT ?` clause from the candidate query in
    // `supersedeMetricSampleOverlaps` — the push-key exclusion, on this side of the
    // ruling. Measured, and it is NOT a delete: `superseded` stays 0 and both rows stay
    // stored, because the re-sent NY row now carries THIS push's stamp and `pushOutranks`
    // refuses an equal one. What moves is the Review line — the NY row is counted in
    // `left` as well as in the push's own excess, so this case reds on
    // `overlapsLeftWarning(1)` reading 2. The exclusion is a narrowing whose safety is
    // held by the equal-stamp comparison behind it; what it buys is a count that says one
    // day reading high rather than two. (17 tests red across the three HC specs, mostly
    // on that count; the property spec's "derives the victim set from the STORE" reds on
    // 4 for 1.)
    const p = freshProfile("BOTH-ANCHORINGS-ONE-PUSH");
    seedNY(p);
    const only = push(p, { steps: [NY, TOKYO] }, "2026-08-21T06:00:05Z");
    expect(only.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([11000, 9000]);
    expect(warningsOf(only)).toContain(overlapsLeftWarning(1));
  });

  it("says so even when the store held NEITHER of the two", () => {
    // ROUND 6's REFUTATION, AND THE GAP THE SEEDING CORRECTION OPENED. Every case above
    // seeds the store, which is right for pinning the push-key exclusion — but it made
    // the store-holds-NEITHER push the one configuration nothing covered, and that is the
    // configuration where the Review line was silent. The declined-candidate half of the
    // count names STORED rows this push did not collapse, and two rows of ONE push are
    // never each other's candidates: they share a stamp. Both rows are written (right,
    // ruling item 3), the day sums 20000 for 11000 walked — and the push reported
    // `superseded: 0`, `overlapsLeft: 0`, `warnings: []`.
    //
    // MUTATION: drop the in-push term from `supersedeMetricSampleOverlaps`'s return
    // (`left.size` alone) and this goes back to a silent wrong total. Measured: 5 red
    // across the three HC specs — this case and "stores both, says so, and deletes
    // nothing" above, "still counts two genuine anchorings" in R8b, plus one each in
    // hc-overlap-supersede.test.ts and hc-overlap-push-property.test.ts. So it is NOT the
    // only case that notices, which an earlier version of this note claimed; what is
    // particular to this one is the store-holds-NEITHER configuration.
    const p = freshProfile("BOTH-ANCHORINGS-EMPTY-STORE");
    const only = push(p, { steps: [NY, TOKYO] }, "2026-08-21T06:00:05Z");
    expect(only.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([11000, 9000]);
    // ONE, not two. The excess is what the day carries beyond the first reading, which is
    // the same number the seeded case above reports for the same symptom — there the
    // stale row is a stored one, here it is the push's own.
    expect(warningsOf(only)).toContain(overlapsLeftWarning(1));
  });

  it("stays quiet when the two buckets of one push do NOT overlap", () => {
    // The other direction, because a count that fires on every multi-day push would be
    // worse than one that never fires. Consecutive day buckets under ONE anchoring tile
    // rather than nest — that is the premise the whole rule rests on — so a push carrying
    // two of them is the ordinary case and says nothing.
    const p = freshProfile("BOTH-ANCHORINGS-DISJOINT");
    const quiet = push(
      p,
      {
        steps: [
          steps("2026-08-19T04:00:00Z", "2026-08-20T04:00:00Z", 8000),
          NY,
        ],
      },
      "2026-08-21T06:00:05Z"
    );
    expect(quiet.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000, 9000]);
    expect(warningsOf(quiet)).toEqual([]);
  });

  it("collapses on the next push that carries only the new anchoring", () => {
    // The half that makes the trade acceptable: it is transient, and it converges
    // WITHOUT anything having to decide between two rows of one push.
    const p = freshProfile("BOTH-ANCHORINGS-CONVERGE");
    seedNY(p);
    push(p, { steps: [NY, TOKYO] }, "2026-08-21T06:00:05Z");
    // A COMPLETED bucket does not grow, so the next push re-sends the same window under
    // a newer stamp — which is all the collapse ever needed: it lands on 08-20, overlaps
    // the stored NY row filed there, and outranks the push that wrote it.
    const next = push(p, { steps: [TOKYO] }, "2026-08-21T12:00:05Z");
    expect(next.split.superseded).toBe(1);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([11000]);
  });

  it("does the same when the pair is SPLIT across chunks", () => {
    // At the shipped chunk size, with 1200 filler rows of other metrics sorting between
    // the two anchorings. Nothing here depends on which chunk a row landed in, which is
    // the property the first refutation was about.
    const p = freshProfile("BOTH-ANCHORINGS-CHUNKED");
    seedNY(p);
    const split = push(
      p,
      {
        steps: [NY, TOKYO],
        ...fillerBuckets("distance", "meters", 2026, 7, 19, 16),
        ...fillerBuckets("active_calories", "calories", 2026, 7, 19, 16),
        ...fillerBuckets("hydration", "liters", 2026, 7, 19, 16),
        ...fillerBuckets("nutrition", "calories", 2026, 7, 19, 16),
      },
      "2026-08-21T06:00:05Z"
    );
    expect(split.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([11000, 9000]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R2 — the premise "an overlap is always the mixed-anchoring anomaly" is FALSE
//      for two shipped shapes.
// ─────────────────────────────────────────────────────────────────────────────

describe("R2 — nutrition at a `full` exporter setting", () => {
  // THE DEFECT. `parseHealthConnectPayload` emits one interval row per nutrient per
  // NutritionRecord with the record's REAL start and end, so a snack logged inside a
  // meal window from one origin is two legitimately nested `nutrition_kcal` rows.
  // `recommendedSettingForKey("nutrition")` is `daily`, but nothing enforces it —
  // FINE_GRAINED_CHECK is informational by its own comment and does not cover nutrition
  // at all. The first cut deleted the 800 kcal meal and kept the 150 kcal snack.
  const MEAL = {
    start_time: "2026-05-01T17:00:00Z",
    end_time: "2026-05-01T18:00:00Z",
    calories: 800,
    metadata: { data_origin: "com.myfitnesspal.android" },
  };
  const SNACK = {
    start_time: "2026-05-01T17:20:00Z",
    end_time: "2026-05-01T17:25:00Z",
    calories: 150,
    metadata: { data_origin: "com.myfitnesspal.android" },
  };

  it("stores BOTH when they arrive in one push", () => {
    // MUTATION: add `nutrition_kcal` to DAY_BUCKET_METRICS. Measured, and this case does
    // NOT move: 6624 db tests green. Two independent reasons, both worth knowing — these
    // two rows arrive in ONE push, so they share a stamp and can never be each other's
    // candidates; and a 1-hour meal and a 5-minute snack are both below the granularity
    // gate, so `isSupersedingWindow` refuses them whatever the metric list says. What the
    // metric list is pinned by is the pure tier: lib/__tests__/metric-window-overlap.test.ts
    // reds 3 of 47 on this mutation ("admits exactly the four metrics Health Connect
    // stores as daily totals", "keeps NUTRITION, HYDRATION and SLEEP out of reach", "is
    // true only for a day-bucket window of a tiling metric"). What THIS case pins is the
    // parse-and-store shape the metric list was chosen from.
    const p = freshProfile("R2-NUTRITION-ONE");
    push(p, { nutrition: [MEAL, SNACK] });
    expect(stored(p, "nutrition_kcal").map((r) => r.value)).toEqual([800, 150]);
  });

  it("does not let a later meal DELETE a stored snack", () => {
    const p = freshProfile("R2-NUTRITION-TWO");
    push(p, { nutrition: [SNACK] });
    const second = push(p, { nutrition: [MEAL] });
    expect(stored(p, "nutrition_kcal").map((r) => r.value)).toEqual([800, 150]);
    expect(second.split.superseded).toBe(0);
  });
});

describe("R2 — sleep", () => {
  // THE DEFECT. `sleep_min` is one row per session on the session's real window, so the
  // DAY-BUCKET rule may never touch one — and `dataOrigin` reads only
  // `metadata.data_origin`, so two devices that set none both parse to `origin = null`
  // and land in ONE supersede group.
  //
  // AND THE CLAIM IS NARROWER SINCE #3628, which is why both cases below push their pair
  // in ONE payload. Two overlapping same-origin sessions ARE now an anomaly the sleep
  // collapse acts on — but only across pushes, because two rows of one push have no
  // arrival order between them (#3424's ruling, item 3). These stay green for that
  // reason rather than by accident; the cross-push direction is
  // lib/__db_tests__/hc-sleep-rezoned-collapse-3628.test.ts.
  it("keeps two overlapping sessions from one origin in ONE push", () => {
    const p = freshProfile("R2-SLEEP-ONE");
    push(p, {
      sleep: [
        {
          start_time: "2026-05-01T22:00:00Z",
          end_time: "2026-05-02T02:00:00Z",
          metadata: { data_origin: ORIGIN },
        },
        {
          start_time: "2026-05-02T01:55:00Z",
          end_time: "2026-05-02T06:00:00Z",
          metadata: { data_origin: ORIGIN },
        },
      ],
    });
    expect(rowCount(p, "sleep_min")).toBe(2);
  });

  it("keeps two DEVICES that both parse to origin = null", () => {
    // MUTATION: add `sleep_min` to DAY_BUCKET_METRICS. Measured, and this case does NOT
    // move: 6624 db tests green. Both sessions arrive in ONE push, so they carry the same
    // stamp and the candidate query excludes each from the other — the metric list never
    // gets to matter here. The list is pinned in the pure tier instead:
    // lib/__tests__/metric-window-overlap.test.ts reds 3 of 47 on this mutation,
    // including "refuses two overlapping SLEEP sessions, including the origin=null group".
    // What THIS case pins is the origin=null grouping the pure test's premise rests on.
    const p = freshProfile("R2-SLEEP-NULL-ORIGIN");
    push(p, {
      sleep: [
        {
          start_time: "2026-05-01T22:00:00Z",
          end_time: "2026-05-02T06:00:00Z",
        },
        {
          start_time: "2026-05-01T22:10:00Z",
          end_time: "2026-05-02T05:50:00Z",
        },
      ],
    });
    expect(rowCount(p, "sleep_min")).toBe(2);
  });

  it("keeps a session and every stage nested inside it", () => {
    // The `withings-sync` witness shape, now asserted on the Health Connect path too:
    // a session window with its stages nested inside it is a legitimate nesting, and
    // two `light` stages in one night are two rows of ONE metric.
    const p = freshProfile("R2-SLEEP-STAGES");
    push(p, {
      sleep: [
        {
          start_time: "2026-05-01T22:00:00Z",
          end_time: "2026-05-02T06:00:00Z",
          metadata: { data_origin: ORIGIN },
          stages: [
            {
              stage: "light",
              start_time: "2026-05-01T22:00:00Z",
              end_time: "2026-05-01T23:00:00Z",
            },
            {
              stage: "deep",
              start_time: "2026-05-01T23:00:00Z",
              end_time: "2026-05-02T01:00:00Z",
            },
            {
              stage: "rem",
              start_time: "2026-05-02T01:00:00Z",
              end_time: "2026-05-02T02:00:00Z",
            },
            {
              stage: "light",
              start_time: "2026-05-02T02:00:00Z",
              end_time: "2026-05-02T06:00:00Z",
            },
          ],
        },
      ],
    });
    expect(rowCount(p, "sleep_min")).toBe(1);
    expect(rowCount(p, "sleep_light_min")).toBe(2);
    expect(rowCount(p, "sleep_deep_min")).toBe(1);
    expect(rowCount(p, "sleep_rem_min")).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R3 (second pass) — a completed re-anchored day, which ends EARLIER than the
//                    still-filling row it corrects.
// ─────────────────────────────────────────────────────────────────────────────

describe("a re-anchored COMPLETED day still corrects the row it overlaps", () => {
  // THE DEFECT THIS PINS, and it is the worst thing either version of this rule did.
  // Freshness once fell back, for a push stating no `timestamp`, to the furthest-forward
  // `ended_at` in that push. An END is a property of the READING. A re-anchored bucket
  // for a day that has FINISHED ends earlier than the old-anchoring "today so far" row
  // it overlaps — so the fallback read the correcting push as the older one and the
  // correcting reading was never written at all:
  //
  //     stored 3000, for 3500 walked, {"inserted":0,"unchanged":1,"superseded":0}
  //
  // The bug this whole file exists to fix reads a day too HIGH, which is visible in
  // every total and repaired by the next push. That read it too LOW, looked exactly like
  // a day you did not walk, and converged on nothing.
  it("writes the 3500 and supersedes the 3000", () => {
    // MUTATION: give the push a stamp derived from its own windows INSTEAD of the stated
    // one (`pushStampFor(latest ended_at) ?? pushStampFor(parsed.pushedAt)`) and this
    // reds: `superseded` reads 0 for 1 and the store keeps both rows. Measured — 9 red
    // across the three HC specs.
    //
    // NOT "any" window-derived stamp, which an earlier version of this note said. The
    // shape this branch actually deleted was a FALLBACK, used only when the payload
    // stated nothing readable; reinstating it that way leaves THIS case green (3 red
    // elsewhere, none of them here), because both pushes state a `timestamp` and the
    // fallback never fires. It is the stated stamp being DISPLACED that loses the
    // reading.
    const p = freshProfile("COMPLETED-DAY-CORRECTS");
    push(
      p,
      {
        steps: [
          {
            start_time: "2026-05-01T04:00:00Z",
            end_time: "2026-05-01T23:00:00Z",
            count: 3000,
            metadata: { data_origin: ORIGIN },
          },
        ],
      },
      "2026-05-01T23:00:05Z"
    );
    const second = push(
      p,
      {
        steps: [
          {
            start_time: "2026-05-01T10:00:00Z",
            end_time: "2026-05-01T22:00:00Z",
            count: 3500,
            metadata: { data_origin: ORIGIN },
          },
        ],
      },
      "2026-05-02T00:00:05Z"
    );
    expect(second.split.superseded).toBe(1);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([3500]);
  });

  it("and a push that states NO stamp deletes nothing, rather than dropping a row", () => {
    // The stampless path, which is what the fallback was invented to serve. It now
    // supersedes nothing — so the day reads HIGH, visibly, instead of a reading going
    // missing.
    //
    // NO MUTATION REDS THIS CASE, and saying so is more use than the claim that used to
    // stand here ("let a stampless push supersede and one of the two rows disappears").
    // Three were run: removing the `pushedAt === null` guard from
    // `supersedeMetricSampleOverlaps` is a NO-OP (`pushed_at = NULL` matches no row, so
    // the stamped set is empty either way) — 6624 db tests green; the window-derived
    // FALLBACK leaves it green too, because the correcting push's latest end is EARLIER
    // than the stored row's, so the fallback stamp fails to outrank and the delete does
    // not happen — the case passes for the wrong reason; the window-derived PRIMARY reds
    // 9 tests but not this one, for the same reason. What holds the stampless rule is the
    // pair below — "leaves the converged row alone when a stale record rides in beside a
    // later one" and "says NOTHING for a push that stamped nothing" — both of which red
    // under either window-derived shape. This case is the readable statement of the
    // designed outcome, not the guard.
    const p = freshProfile("NO-STAMP-KEEPS-BOTH");
    const body = (start: string, end: string, count: number) => ({
      steps: [
        {
          start_time: start,
          end_time: end,
          count,
          metadata: { data_origin: ORIGIN },
        },
      ],
    });
    guarded(p, () =>
      ingestHealthConnectPayload(
        p,
        parseHealthConnectPayload(
          body("2026-05-01T04:00:00Z", "2026-05-01T23:00:00Z", 3000),
          "UTC"
        )
      )
    );
    const second = guarded(p, () =>
      ingestHealthConnectPayload(
        p,
        parseHealthConnectPayload(
          body("2026-05-01T10:00:00Z", "2026-05-01T22:00:00Z", 3500),
          "UTC"
        )
      )
    );
    expect(second.split.superseded).toBe(0);
    expect(
      stored(p, "steps")
        .map((r) => r.value)
        .sort()
    ).toEqual([3000, 3500]);
  });
});

describe("a STAMPLESS push can never delete, however its rows are bundled", () => {
  // The sharpest form of the window-fallback defect, and the one a merely-harmless case
  // cannot catch. A fallback of "furthest-forward end in the push" is computed over the
  // WHOLE push, so bundling a stale re-sent record with an unrelated row that happens to
  // end later — a hydration row, here — manufactures a stamp newer than the row it would
  // then delete. Nothing about the steps data changed; a glass of water did.
  const unstamped = (body: Record<string, unknown>) => {
    const parsed = parseHealthConnectPayload(body, "UTC");
    lastParsedDetails = parsed.details;
    return guarded(p0(), () => ingestHealthConnectPayload(p0(), parsed));
  };
  let profile = 0;
  const p0 = () => profile;

  it("leaves the converged row alone when a stale record rides in beside a later one", () => {
    profile = freshProfile("STAMPLESS-BUNDLED");
    unstamped({
      steps: [steps("2026-05-01T04:00:00Z", "2026-05-01T23:00:00Z", 3000)],
    });
    unstamped({
      steps: [steps("2026-05-01T10:00:00Z", "2026-05-02T01:00:00Z", 3500)],
    });
    // The replay, bundled with a hydration row reaching further forward than anything
    // stored. MUTATION: give `pushStampFor` any window-derived fallback and the 3500
    // row is deleted here, by a push that stated no time at all.
    const third = unstamped({
      steps: [steps("2026-05-01T04:00:00Z", "2026-05-01T23:00:00Z", 3000)],
      hydration: [
        {
          start_time: "2026-05-02T01:00:00Z",
          end_time: "2026-05-02T02:00:00Z",
          liters: 0.3,
          metadata: { data_origin: ORIGIN },
        },
      ],
    });
    expect(third.split.superseded).toBe(0);
    expect(
      stored(profile, "steps")
        .map((r) => r.value)
        .sort()
    ).toEqual([3000, 3500]);
  });

  it("says so in Review when a STAMPED push leaves a day reading high", () => {
    // THE LINE REPORTS WHAT HAPPENED, NEVER WHY. A stamp older than the stored row's is
    // one of several reasons a supersede is declined — a phone whose clock went BACKWARDS
    // stamps every push in the past — and the person reading the total does not care
    // which. The store-derived predicate reports it from the same query that decides the
    // deletes, so the reason never has to be enumerated anywhere.
    //
    // MUTATION: drop `overlapsLeft = outcome.overlapsLeft` in
    // `ingestHealthConnectPayload` and this goes silent — measured, 6 red across the
    // three HC specs, this case among them.
    //
    // Returning `left.size` alone does NOT red this case (5 red, none of them here): the
    // double count here is a STORED row the predicate declined, which lives in `left`, so
    // dropping the in-push term leaves this number right. That half is pinned by the two
    // cases in "a push carrying BOTH anchorings…" above. And there is no prune to drop
    // any more — the line that re-subtracted collapsed ids was unreachable and is gone.
    profile = freshProfile("OVERLAP-LEFT-WARNS");
    // The store: a converged row, stamped LATE.
    push(
      profile,
      { steps: [steps("2026-05-01T10:00:00Z", "2026-05-02T01:00:00Z", 3500)] },
      "2026-05-02T04:00:00Z"
    );
    // A push whose phone is running behind: its rows LAND and are stamped, but they do
    // not outrank what is stored, so the day is left reading high and says so.
    const second = push(
      profile,
      { steps: [steps("2026-05-01T04:00:00Z", "2026-05-01T23:00:00Z", 3000)] },
      "2026-05-02T02:00:00Z"
    );
    expect(second.split.superseded).toBe(0);
    expect(
      stored(profile, "steps")
        .map((r) => r.value)
        .sort()
    ).toEqual([3000, 3500]);
    expect(warningsOf(second)).toContain(overlapsLeftWarning(1));
  });

  it("says NOTHING for a push that stamped nothing — the cost, in writing", () => {
    // A CHANGE THIS BRANCH MADE ON PURPOSE, AND THE PLACE IT IS RECORDED (#3438, the
    // ruling of 2026-08-22T13:46Z). `overlapsLeft` used to be summed from a read-only pass
    // over the PAYLOAD, so a push that stated no readable `timestamp` could still report
    // the overlaps its windows sat on. The victim set — and with it the report — is now
    // derived from the rows carrying THIS push's stamp, and a stampless push writes
    // `pushed_at` NULL: there is no way to tell its rows from the pre-column NULLs beside
    // them, so there is no query to report from.
    //
    // WHAT IT COSTS, bounded: of 228 captured exporter payloads, all 175 carrying an
    // `app_version` — every real push — state a readable `timestamp`. The reachable cases
    // are a phone more than MAX_PUSH_CLOCK_SKEW_MS ahead of this server and a non-exporter
    // caller. Both leave the double count VISIBLE in the totals; what they lose is the
    // sentence in Review naming it. The alternative was keeping a payload-side pre-pass
    // alive purely to compute a warning, which is the construction rounds 7-9 died on.
    profile = freshProfile("OVERLAP-LEFT-STAMPLESS");
    unstamped({
      steps: [steps("2026-05-01T04:00:00Z", "2026-05-01T23:00:00Z", 3000)],
    });
    const second = unstamped({
      steps: [steps("2026-05-01T10:00:00Z", "2026-05-02T01:00:00Z", 3500)],
    });
    // The rows are both there — the double count is real and visible in the day total.
    expect(second.split.superseded).toBe(0);
    expect(
      stored(profile, "steps")
        .map((r) => r.value)
        .sort()
    ).toEqual([3000, 3500]);
    expect(warningsOf(second)).toEqual([]);

    // A stamp the CLOCK BOUND refuses is the same case: `pushStampFor` returns null, so
    // the push writes no stamp and derives nothing.
    const far = new Date(Date.now() + 40 * 24 * 60 * 60 * 1000).toISOString();
    const third = push(
      profile,
      { steps: [steps("2026-05-01T09:00:00Z", "2026-05-02T02:00:00Z", 3600)] },
      far.slice(0, 19) + "Z"
    );
    expect(third.split.superseded).toBe(0);
    expect(warningsOf(third)).toEqual([]);
  });

  it("stays quiet when there was no overlap to leave standing", () => {
    // MUTATION: emit the line unconditionally, or from a shape test that answers true
    // for everything, and every ordinary push starts announcing a problem it does not
    // have — which is how a real signal gets tuned out. Measured: 12 red across the three
    // HC specs, this case among them (11 before the assertion below was repaired).
    //
    // IT MATCHES ON TEXT THE LINE ACTUALLY CARRIES. It used to look for "timezone
    // change", which `overlapsLeftWarning` stopped saying when it stopped naming a cause
    // — so both assertions were true of every possible output and the stated mutation
    // could not have reddened this case.
    profile = freshProfile("OVERLAP-LEFT-QUIET");
    const only = unstamped({
      steps: [steps("2026-05-01T10:00:00Z", "2026-05-02T01:00:00Z", 3500)],
    });
    expect(warningsOf(only).some((w) => w.includes(OVERLAP_LINE))).toBe(false);
    // Nor for a payload with nothing the rule could ever act on.
    const points = unstamped({
      heart_rate_variability: [
        { time: "2026-05-01T10:00:00Z", milliseconds: 40 },
      ],
    });
    expect(warningsOf(points).some((w) => w.includes(OVERLAP_LINE))).toBe(
      false
    );
  });
});

describe("the stored stamp is canonical", () => {
  it("re-serializes whatever spelling the exporter used", () => {
    // MUTATION: hand `upsertMetricSamples` `parsed.pushedAt` raw instead of routing it
    // through `pushStampFor`, and `metric_samples.pushed_at` starts holding two shapes,
    // skipping the clock-skew bound on the way past. Measured: 2 red across the three HC
    // specs — this case and "says NOTHING for a push that stamped nothing".
    //
    // AND THIS CASE IS WHAT HOLDS IT. lib/__tests__/time-columns.test.ts stays green
    // under the mutation (15 passed): it is a registry-and-docs ratchet over the declared
    // shape of each column, with no writer in it, so it cannot see a writer that stops
    // canonicalising. `docs/internals/time-columns.md` declares this column `canonical`;
    // this assertion is the only place that makes the declaration true.
    const p = freshProfile("CANONICAL-STAMP");
    push(
      p,
      {
        steps: [
          {
            start_time: "2026-05-01T10:00:00Z",
            end_time: "2026-05-02T01:00:00Z",
            count: 3500,
            metadata: { data_origin: ORIGIN },
          },
        ],
      },
      "2026-05-02T01:00:05.250Z"
    );
    const row = db
      .prepare(
        "SELECT pushed_at FROM metric_samples WHERE profile_id = ? AND metric = 'steps'"
      )
      .get(p) as { pushed_at: string };
    expect(row.pushed_at).toBe("2026-05-02T01:00:05Z");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R4 — an ordinary exporter retry.
// ─────────────────────────────────────────────────────────────────────────────

describe("R4 — a byte-identical replay of a pre-switch push", () => {
  // THE DEFECT. The ingest route has no idempotency key, so a 5xx retry or a queued
  // webhook replays a whole payload. After the store had converged, replaying the
  // pre-switch Tokyo payload DELETED the current Honolulu row and re-inserted the stale
  // one — the day rolled back from 3500 to 3000. The old freshness guard could not see
  // it: it compared against the incoming row's natural-key TWIN, and the supersede had
  // already deleted that twin.
  const TOKYO = {
    steps: [
      {
        start_time: "2026-05-01T04:00:00Z",
        end_time: "2026-05-01T23:00:00Z",
        count: 3000,
        metadata: { data_origin: ORIGIN },
      },
    ],
  };
  const HONOLULU = {
    steps: [
      {
        start_time: "2026-05-01T10:00:00Z",
        end_time: "2026-05-02T01:00:00Z",
        count: 3500,
        metadata: { data_origin: ORIGIN },
      },
    ],
  };

  const T1 = "2026-05-01T23:00:05Z";
  const T2 = "2026-05-02T01:00:05Z";

  it("DELETES NOTHING — the converged row survives the replay", () => {
    // MUTATION: drop `pushOutranks` from planSupersede and the replay deletes the 3500
    // row. That is the loss this guard exists for.
    const p = freshProfile("R4-REPLAY");
    push(p, TOKYO, T1);
    push(p, HONOLULU, T2);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([3500]);

    const replay = push(p, TOKYO, T1);
    expect(replay.split.superseded).toBe(0);
    // The stale row IS re-inserted, and that is the deliberate trade: the day reads
    // high until the next push, which is VISIBLE in every total. The version that
    // suppressed the write instead could drop a correcting reading and report
    // "nothing new" — a wrong number a person can see beats a missing one they cannot.
    expect(
      stored(p, "steps")
        .map((r) => r.value)
        .sort()
    ).toEqual([3000, 3500]);
  });

  it("and the NEXT genuine push collapses what the replay left", () => {
    // The other half of that trade, and the reason it is acceptable: the double count
    // is transient. MUTATION, stated as something runnable rather than as a class: stamp
    // rows with ARRIVAL time instead of the payload's (`pushStampFor(new
    // Date().toISOString())` in `ingestHealthConnectPayload`). `pushStampFor` resolves to
    // the second, so all four pushes here land inside one and share a stamp, nothing
    // outranks anything, and this reads `superseded: 0` for 1 — it stops converging.
    // Measured: 22 red across the three HC specs, this case and the one above among them.
    const p = freshProfile("R4-CONVERGES");
    push(p, TOKYO, T1);
    push(p, HONOLULU, T2);
    push(p, TOKYO, T1);
    const next = push(p, HONOLULU, "2026-05-02T02:00:05Z");
    expect(next.split.superseded).toBe(1);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([3500]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R5 — the DELETE's profile scoping, which no behavioural test can observe.
// ─────────────────────────────────────────────────────────────────────────────

describe("R5 — the supersede DELETE names profile_id", () => {
  // THE SECOND HALF OF THIS GUARD IS NOT HERE, and that is the answer rather than a gap.
  // Every id handed to the DELETE came out of the profile-scoped candidate SELECT, so
  // neutralising the DELETE's own `profile_id` clause leaves the entire DB tier green —
  // measured: 763 files, 6504 tests, exit 0. No behavioural test can see it.
  //
  // What CAN see it already ships: lib/__tests__/profile-scoping.test.ts censuses every
  // owned-table `.prepare()` literal in the tree and fails when one does not filter by
  // profile_id. Removing the clause makes THAT go red, by name. Writing a second
  // assertion here would have meant hoisting the SQL to a constant — which is precisely
  // what blinds the census, since it cannot read a non-literal `.prepare()`. Measured:
  // doing so failed the census with "non-literal .prepare(SUPERSEDE_DELETE_SQL) —
  // cannot verify scoping".
  //
  // The behavioural half below pins the candidate SELECT, which is the barrier that
  // does the work.
  it("keeps another profile's overlapping row of the same metric and origin", () => {
    // The behavioural half, which pins the SELECT: another profile's overlapping row of
    // the same metric and origin survives.
    const mine = freshProfile("R5-MINE");
    const theirs = freshProfile("R5-THEIRS");
    const row = (
      started_at: string,
      ended_at: string,
      value: number
    ): NormMetricSample => ({
      metric: "steps",
      date: "2026-05-01",
      started_at,
      ended_at,
      value,
      origin: ORIGIN,
    });
    upsert(
      theirs,
      [row("2026-05-01T00:00:00Z", "2026-05-01T20:00:00Z", 777)],
      HC
    );
    upsert(
      mine,
      [row("2026-05-01T00:00:00Z", "2026-05-01T20:00:00Z", 111)],
      HC
    );
    const counts = upsert(
      mine,
      [row("2026-05-01T04:00:00Z", "2026-05-01T23:00:00Z", 222)],
      HC
    );
    expect(counts.superseded).toBe(1);
    expect(stored(theirs, "steps").map((r) => r.value)).toEqual([777]);
    expect(stored(mine, "steps").map((r) => r.value)).toEqual([222]);
  });
});

describe("m24i — a Health Connect push meets a FOREIGN source's row", () => {
  // THE MUTANT THAT SURVIVED THE WHOLE SUITE. The source gate exists twice — the
  // `supersedes` flag, and `AND source = ?` in the candidate SELECT — and only the flag
  // was observed. Every "leaves other sources alone" case pushed a NON-HC source at
  // non-HC rows, so an HC push had never been let anywhere near a foreign row. Drop the
  // SELECT's clause and a Health Connect push DELETES A WITHINGS ROW, with both tiers
  // green.
  //
  // The window below is deliberately one a Withings sleep session really can occupy and
  // one the rule really would act on if it could see it: same profile, same metric, same
  // origin (null on both), overlapping, day-bucket granularity, no edit lock, and an
  // older `pushed_at` — every precondition satisfied except the source.
  it("never reaches it, whatever else lines up", () => {
    const p = freshProfile("M24I-FOREIGN-SOURCE");
    const foreign: NormMetricSample = {
      metric: "steps",
      date: "2026-05-01",
      started_at: "2026-05-01T00:00:00Z",
      ended_at: "2026-05-01T20:00:00Z",
      value: 4242,
      origin: null,
    };
    upsert(p, [foreign], "withings");
    // ...and an ordinary Health Connect day bucket that covers the same window.
    const counts = upsert(
      p,
      [{ ...foreign, started_at: "2026-05-01T04:00:00Z", value: 9000 }],
      HC
    );
    expect(counts.superseded).toBe(0);
    const bySource = db
      .prepare(
        `SELECT source, value FROM metric_samples
          WHERE profile_id = ? AND metric = 'steps' ORDER BY source`
      )
      .all(p) as { source: string; value: number }[];
    expect(bySource).toEqual([
      { source: HC, value: 9000 },
      { source: "withings", value: 4242 },
    ]);
  });

  it("and the reverse: a foreign push never reaches a Health Connect row", () => {
    const p = freshProfile("M24I-REVERSE");
    const row: NormMetricSample = {
      metric: "steps",
      date: "2026-05-01",
      started_at: "2026-05-01T04:00:00Z",
      ended_at: "2026-05-02T04:00:00Z",
      value: 9000,
      origin: null,
    };
    upsert(p, [row], HC);
    upsert(
      p,
      [{ ...row, started_at: "2026-05-01T00:00:00Z", value: 4242 }],
      "withings"
    );
    expect(
      (
        db
          .prepare(
            "SELECT COUNT(*) AS n FROM metric_samples WHERE profile_id = ? AND metric = 'steps'"
          )
          .get(p) as { n: number }
      ).n
    ).toBe(2);
  });
});

describe("the superseded count equals the rows actually removed", () => {
  it("counts every delete, and only deletes", () => {
    const p = freshProfile("COUNT-EXACT");
    const row = (
      started_at: string,
      ended_at: string,
      value: number
    ): NormMetricSample => ({
      metric: "steps",
      date: "2026-05-01",
      started_at,
      ended_at,
      value,
      origin: ORIGIN,
    });
    upsert(
      p,
      [
        row("2026-05-01T00:00:00Z", "2026-05-01T06:00:00Z", 1),
        row("2026-05-01T06:00:00Z", "2026-05-01T12:00:00Z", 2),
        row("2026-05-01T12:00:00Z", "2026-05-01T18:00:00Z", 3),
      ],
      HC
    );
    const before = rowCount(p, "steps");
    const counts = upsert(
      p,
      [row("2026-05-01T01:00:00Z", "2026-05-01T20:00:00Z", 9)],
      HC
    );
    const after = rowCount(p, "steps");
    // Three removed, one inserted.
    expect(counts.superseded).toBe(3);
    expect(before - after).toBe(2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// D1 — WHERE PASS B COMMITS, which is the one thing the owner reversed.
// ─────────────────────────────────────────────────────────────────────────────

describe("D1 — the deletes commit with the LAST chunk", () => {
  // THE DEFECT, AND IT SHIPPED IN THREE ROUNDS OF THIS PR. Pass B ran inside the FIRST
  // chunk's transaction, justified by a sentence that is still true — "a crash between
  // the deletes and the writes must not leave a day reading LOW with nothing in flight
  // to restore it". First-chunk placement satisfies that only when the push is ONE
  // chunk. Split it and the sentence is inverted: the deletes commit with chunk 1,
  // chunk 2 fails, and the day reads NOTHING where `main` still reads the old row —
  // measured at 8000 → nothing. The owner corrected the placement (#3424, the ruling of
  // 2026-08-22) and pinned the invariant instead:
  //
  //     at every commit point the store holds the OLD rows, or OLD + NEW, or NEW —
  //     NEVER NEITHER. A day may read HIGH between commits; it must never read LOWER
  //     than `main` would.
  //
  // MUTATION: move `supersedeMetricSampleOverlaps` back to the first chunk
  // (`remaining === orderedSamples.length - slice.length`, or the `pending` flag the
  // earlier rounds used) in `ingestHealthConnectPayload`. The CRASH test then finds the
  // seeded 8000 gone — measured, 10 red across the three HC specs.
  //
  // IT IS THE CRASH TEST ALONE, not "both tests below". The one-chunk case cannot move
  // under it by construction: with a single chunk the first chunk IS the last one, so
  // first-chunk and last-chunk placement are the same placement. What that case pins is
  // the rollback, and its mutation is a different one — anything that takes the deletes
  // out of the chunk's transaction.

  const LA = "2026-05-01T07:00:00Z";

  /** The pre-push store: one NY-anchored day bucket, stamped by an earlier push. */
  function seedNyDay(p: number): void {
    push(
      p,
      {
        app_version: "1.9.14",
        steps: [
          {
            start_time: "2026-05-01T04:00:00Z",
            end_time: "2026-05-02T04:00:00Z",
            count: 8000,
            metadata: { data_origin: ORIGIN },
          },
        ],
      },
      "2026-05-02T05:00:00Z"
    );
  }

  /** Three LA-anchored day buckets — one chunk each at chunkSize 1, in start order. */
  const LA_PUSH = {
    app_version: "1.9.14",
    steps: [
      {
        start_time: "2026-04-30T07:00:00Z",
        end_time: "2026-05-01T07:00:00Z",
        count: 7000,
        metadata: { data_origin: ORIGIN },
      },
      {
        start_time: LA,
        end_time: "2026-05-02T07:00:00Z",
        count: 8100,
        metadata: { data_origin: ORIGIN },
      },
      {
        start_time: "2026-05-02T07:00:00Z",
        end_time: "2026-05-03T07:00:00Z",
        count: 900,
        metadata: { data_origin: ORIGIN },
      },
    ],
  };

  /**
   * Make one statement of the real write path fail, the way a disk error or a constraint
   * would: a trigger scoped to ONE profile that ABORTs. It fails INSIDE the chunk's
   * transaction, which is the only way to observe where a transaction boundary actually
   * falls — a spy on the module would test the mock's boundaries instead of SQLite's.
   */
  function abortOn(sql: string): () => void {
    db.exec(`CREATE TEMP TRIGGER d1_abort ${sql}`);
    return () => db.exec("DROP TRIGGER d1_abort");
  }

  function pushChunked(
    p: number,
    body: Record<string, unknown>,
    timestamp: string,
    chunkSize: number
  ) {
    const parsed = parseHealthConnectPayload({ ...body, timestamp }, "UTC");
    lastParsedDetails = parsed.details;
    return guarded(p, () =>
      ingestHealthConnectPayload(p, parsed, HC, chunkSize)
    );
  }

  it("leaves the OLD row plus the committed chunks when chunk 2 of 3 fails", () => {
    const p = freshProfile("D1-CHUNK-2-FAILS");
    seedNyDay(p);
    // THE SEED IS REALLY THERE. Every assertion below is about what SURVIVED, and a
    // survival assertion over an empty table passes for the wrong reason.
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000]);

    const undo = abortOn(
      `BEFORE INSERT ON metric_samples WHEN NEW.profile_id = ${p}
         AND NEW.started_at = '${LA}'
       BEGIN SELECT RAISE(ABORT, 'chunk 2 fails'); END`
    );
    try {
      expect(() =>
        pushChunked(p, LA_PUSH, "2026-05-02T06:00:00Z", 1)
      ).toThrow();
    } finally {
      undo();
    }

    // NOT NOTHING. The seeded 8000 is still there — chunk 3 never committed, so pass B
    // never ran — beside chunk 1's row, which did commit. That is "old + chunks<k": a
    // day reading HIGH, which is visible and repairable, and never a hole.
    expect(stored(p, "steps").map((r) => r.value)).toEqual([7000, 8000]);

    // AND IT CONVERGES. The exporter re-carries the unacked rows on its next push, which
    // derives its victims from the store the failure left and collapses the double count.
    // Nothing else has to notice the failed push happened.
    const again = pushChunked(p, LA_PUSH, "2026-05-02T07:30:00Z", 1);
    expect(again.split.superseded).toBe(1);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([7000, 8100, 900]);
  });

  it("rolls the deletes back with the rows when the push is ONE chunk", () => {
    // THE ONE-CHUNK CASE: the deletes and the rows are in the SAME transaction, so
    // neither can land without the other. Asserted from the rollback direction, because
    // that is the direction that can distinguish it — failing the DELETE (which runs
    // after the chunk's upserts) must take the chunk's INSERTS down with it.
    const p = freshProfile("D1-ONE-CHUNK-ATOMIC");
    seedNyDay(p);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000]);

    const undo = abortOn(
      `BEFORE DELETE ON metric_samples WHEN OLD.profile_id = ${p}
       BEGIN SELECT RAISE(ABORT, 'the delete fails'); END`
    );
    try {
      expect(() =>
        pushChunked(p, LA_PUSH, "2026-05-02T06:00:00Z", 500)
      ).toThrow();
    } finally {
      undo();
    }
    // EXACTLY the pre-push store: the three rows that were upserted in that transaction
    // went with the failed delete. If they had committed separately, they would be here.
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000]);

    // The same push, unpoisoned, in one chunk: the deletes and the rows land together.
    const ok = pushChunked(p, LA_PUSH, "2026-05-02T07:30:00Z", 500);
    expect(ok.split.superseded).toBe(1);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([7000, 8100, 900]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R7 — pass A planned a delete for a row pass C was FORBIDDEN to write.
// ─────────────────────────────────────────────────────────────────────────────

describe("R7 — a row pass C will not write plans no delete", () => {
  // THE REFUTATION. `final store = (pre-store − victims) ⊕ upserts` assumed `⊕ upserts`
  // was TOTAL. It is not: pass C holds four unilateral vetoes over what lands, and pass A
  // consulted none of them. It promoted the stored old-anchoring row to `victims` on the
  // strength of an incoming re-anchored row that the #508 tombstone then stopped pass C
  // from writing, and pass B deleted the stored row anyway. The day went to ZERO — the
  // committed FINAL state, not a between-commits transient, and the next push re-plans,
  // finds no victim, re-suppresses the incoming row and leaves it at zero forever.
  // `warnings: []`, and `superseded: 1` told the reader a row had been REPLACED.
  //
  // Nothing recovers it. The supersede delete is sync-internal by design: no re-import
  // tombstone (pinned in hc-overlap-supersede.test.ts) and no undo capture, because it is
  // a raw `dropOverlap.run()` rather than the undo-delete path.
  //
  // REACHABLE FROM THE UI THIS PR EXISTS FOR. `app/(app)/data/manage-actions.ts` writes a
  // `metric_samples` tombstone keyed on the row's exact `started_at` when a user deletes a
  // reading. A user sees today's step count duplicated across two anchorings, deletes the
  // RE-ANCHORED one, and the next rolling-window push destroys the other.
  //
  // AND THE VETOES ARE NOT CONSULTED ANY MORE — they do not have to be. The victim set is
  // derived from the rows carrying this push's stamp (#3424, the ruling of
  // 2026-08-22T13:46Z), and a vetoed row is never written and never stamped, so it
  // justifies nothing without any pass asking why.
  //
  // MUTATION for every case below: weaken the first query's `AND pushed_at = ?` in
  // `supersedeMetricSampleOverlaps` to `AND (pushed_at = ? OR 1 = 1)` — "any stored row
  // justifies" rather than "a row THIS push wrote justifies" — and the stored reading is
  // deleted, so the day reads lower than `main` would, which is the one thing the
  // ruling's invariant forbids outright.

  /** The Data → Manage delete, through the same key builder that action uses. */
  function tombstone(p: number, startedAt: string): void {
    writeImportTombstone(
      p,
      "metric_samples",
      metricSampleTombstoneKey("steps", HC, ORIGIN, startedAt)
    );
  }

  function pushAt(
    p: number,
    body: Record<string, unknown>,
    timestamp: string,
    chunkSize: number
  ) {
    const parsed = parseHealthConnectPayload(
      { app_version: "1.9.14", ...body, timestamp },
      "UTC"
    );
    lastParsedDetails = parsed.details;
    return guarded(p, () =>
      ingestHealthConnectPayload(p, parsed, HC, chunkSize)
    );
  }

  it("keeps the stored row when a TOMBSTONE stops the row that would replace it", () => {
    // The lens's configuration, through the real ingest at chunkSize 2.
    const p = freshProfile("R7-TOMBSTONE-VICTIM");
    pushAt(
      p,
      { steps: [steps("2026-05-01T00:00:00Z", "2026-05-01T23:00:00Z", 8000)] },
      "2026-05-02T00:00:00Z",
      2
    );
    // THE SEED IS REALLY THERE — a survival assertion over an empty table passes for the
    // wrong reason, and the shipped tombstone case seeds a FRESH profile, which is why
    // the suite could not see this.
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000]);
    tombstone(p, "2026-05-01T04:00:00Z");

    const result = pushAt(
      p,
      { steps: [steps("2026-05-01T04:00:00Z", "2026-05-02T01:00:00Z", 8500)] },
      "2026-05-02T02:00:00Z",
      2
    );
    expect(result.split.suppressed).toBe(1);
    expect(result.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000]);
    // Nothing to report: one reading stands where one reading stood. The suppressed row
    // put nothing in the store, so there is no day reading high to name.
    expect(warningsOf(result)).toEqual([]);

    // AND IT STAYS THAT WAY. The defect's worst property was that the zero was permanent,
    // so the next push of the same rolling window is driven too.
    const again = pushAt(
      p,
      { steps: [steps("2026-05-01T04:00:00Z", "2026-05-02T01:00:00Z", 8500)] },
      "2026-05-02T03:00:00Z",
      2
    );
    expect(again.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000]);
  });

  it("keeps the stored row when the #133 LOCK stops the row that would replace it", () => {
    // The same construction through a different veto, which is the point: guarding the
    // tombstone alone would have left this one live.
    const p = freshProfile("R7-LOCK-VICTIM");
    // Both anchorings in ONE push, so neither is the other's victim (ruling item 3).
    pushAt(
      p,
      {
        steps: [
          steps("2026-05-01T00:00:00Z", "2026-05-01T23:00:00Z", 8000),
          steps("2026-05-01T04:00:00Z", "2026-05-02T01:00:00Z", 8500),
        ],
      },
      "2026-05-02T00:00:00Z",
      2
    );
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000, 8500]);
    // The user hand-corrects the re-anchored one.
    db.prepare(
      "UPDATE metric_samples SET edited = 1 WHERE profile_id = ? AND started_at = ?"
    ).run(p, "2026-05-01T04:00:00Z");

    const result = pushAt(
      p,
      { steps: [steps("2026-05-01T04:00:00Z", "2026-05-02T01:00:00Z", 9999)] },
      "2026-05-02T02:00:00Z",
      2
    );
    expect(result.split.edited).toBe(1);
    expect(result.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000, 8500]);
    // AND IT SAYS NOTHING, WHICH IS A CHANGE AND A COST — recorded rather than smoothed
    // over (#3438, the ruling of 2026-08-22T13:46Z). The payload-side plan used to report
    // this day by looking up the VETOED row's stored twin and counting what that twin
    // overlapped. The store-derived predicate has no payload to look anything up from: it
    // asks what carries THIS push's stamp, every row of this push was refused, and a push
    // that landed nothing has nothing to say. The two stored rows really do overlap and
    // the day really does read high; naming them means asking "do two STORED rows overlap
    // each other", which is a different scan with a different unit and would change the
    // line on every push rather than on this one. `main` is silent here too.
    expect(warningsOf(result)).toEqual([]);
  });

  it("keeps the stored row when the #1101 STALE RETRY stops the row that would replace it", () => {
    const p = freshProfile("R7-STALE-VICTIM");
    pushAt(
      p,
      {
        steps: [
          steps("2026-05-01T00:00:00Z", "2026-05-01T23:00:00Z", 8000),
          steps("2026-05-01T04:00:00Z", "2026-05-02T01:00:00Z", 8500),
        ],
      },
      "2026-05-02T00:00:00Z",
      2
    );
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000, 8500]);
    // A queued push drains late: the same natural key, an END that stopped EARLIER, a
    // smaller value. #1101 holds the stored snapshot, so this row lands nowhere.
    const result = pushAt(
      p,
      { steps: [steps("2026-05-01T04:00:00Z", "2026-05-01T20:00:00Z", 6000)] },
      "2026-05-02T02:00:00Z",
      2
    );
    expect(result.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000, 8500]);
    // Silent for the same reason as the lock case above: nothing this push carried
    // landed, so nothing carries its stamp and there is no query to report from.
    expect(warningsOf(result)).toEqual([]);
  });

  it("prunes a row a vetoed bucket left standing and a landing bucket collapsed", () => {
    // A VETOED BUCKET DOES NOT STOP A LANDING ONE. The push carries two rows: one the
    // #133 lock refuses, one that lands, overlaps the same stored row and outranks it.
    // The stored row is collapsed on the strength of the row that LANDED, and the locked
    // twin — which is a real day reading high — is the one the Review line names.
    //
    // THE PRUNE THIS CASE ONCE PINNED IS NOW STRUCTURALLY UNREACHABLE, and saying so is
    // the point of keeping the case. Under the payload-side plan the veto was a fact
    // about the INCOMING row, so one stored row could be left standing by a vetoed bucket
    // and collapsed by a landing one, and `leftStanding.delete(victim)` was the arbiter.
    // The store-derived predicate never sees an incoming row: every reason a candidate is
    // declined is a fact about that stored row plus this push's one stamp, so no two
    // stamped buckets can disagree — and after #3424's cover-the-day ruling they also
    // share the `date`, which narrows it further. The prune is DELETED (`CLAUDE.md`: no
    // defensive check for a condition control flow already proves; the owner ruled on it
    // for this PR after a lens confirmed it dead). What this case discriminates now is
    // the lock and the collapse.
    //
    // MUTATION: drop the `if (row.edited)` branch in `planSupersede` and the
    // hand-corrected 8500 goes with the 8000.
    const p = freshProfile("R7-PRUNE");
    pushAt(
      p,
      {
        steps: [
          steps("2026-05-01T00:00:00Z", "2026-05-01T23:00:00Z", 8000),
          steps("2026-05-01T04:00:00Z", "2026-05-02T01:00:00Z", 8500),
        ],
      },
      "2026-05-02T00:00:00Z",
      2
    );
    // The user hand-corrects the re-anchored row, so the push's re-send of it is vetoed.
    db.prepare(
      "UPDATE metric_samples SET edited = 1 WHERE profile_id = ? AND started_at = ?"
    ).run(p, "2026-05-01T04:00:00Z");
    const result = pushAt(
      p,
      {
        steps: [
          // Vetoed by the #133 lock — its twin stays, and the 8000 row it overlaps is
          // left standing on its account.
          steps("2026-05-01T04:00:00Z", "2026-05-02T01:00:00Z", 9999),
          // Lands, overlaps the same 8000 row, outranks it: that row is collapsed.
          steps("2026-05-01T07:00:00Z", "2026-05-02T07:00:00Z", 8100),
        ],
      },
      "2026-05-02T02:00:00Z",
      2
    );
    expect(result.split.superseded).toBe(1);
    expect(result.split.edited).toBe(1);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8500, 8100]);
    // ONE reading standing over the day, not two: the locked row. The 8000 row is gone.
    expect(warningsOf(result)).toContain(overlapsLeftWarning(1));
  });

  it("still collapses the stored row when a row of the SAME push DOES land", () => {
    // A VETOED ROW DECLINES A DELETE; IT DOES NOT VETO THE PUSH. The re-anchored bucket
    // here is tombstoned and lands nowhere, but a second bucket of the same push does
    // land, does overlap the stored row, is filed under the stored row's own `date` and
    // does outrank it — so the collapse happens and the day is left reading right.
    // MUTATION: skip the whole PUSH when any row is vetoed, and the stored row survives
    // beside the new one with the day reading 16100.
    //
    // AND THIS IS THE CONTROL FOR THE COVER-THE-DAY RULING (R10, below). What licenses
    // the delete here is a landed bucket ON 05-01, the victim's date. Round 10's attack
    // is the same shape with the landing bucket on the PREVIOUS date, where it licenses
    // nothing — so if this case ever stopped collapsing, the `date` term would have been
    // widened past what the ruling asks for.
    const p = freshProfile("R7-MIXED");
    pushAt(
      p,
      { steps: [steps("2026-05-01T00:00:00Z", "2026-05-01T23:00:00Z", 8000)] },
      "2026-05-02T00:00:00Z",
      2
    );
    tombstone(p, "2026-05-01T04:00:00Z");
    const result = pushAt(
      p,
      {
        steps: [
          // Vetoed: tombstoned, lands nowhere.
          steps("2026-05-01T04:00:00Z", "2026-05-02T01:00:00Z", 8500),
          // Lands, overlaps the stored row, outranks it.
          steps("2026-05-01T07:00:00Z", "2026-05-02T07:00:00Z", 8100),
        ],
      },
      "2026-05-02T02:00:00Z",
      2
    );
    expect(result.split.suppressed).toBe(1);
    expect(result.split.superseded).toBe(1);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8100]);
    expect(warningsOf(result)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R8 / R9 — the class: a fact read at one moment, acted on at another.
// ─────────────────────────────────────────────────────────────────────────────

describe("R8/R9 — the victim set is derived from the store, under the lock", () => {
  // THE CLASS, AND WHY THESE THREE CASES SHARE A BLOCK. Rounds 7, 8 and 9 were one
  // defect wearing three faces: a read-only plan over the PAYLOAD decided what to delete,
  // and by the time the DELETE ran a veto had fired or a writer had moved the fact the
  // plan rested on. Round 7 was in-process (the #508 tombstone refusing the replacement).
  // Round 8 was cross-process (the user deleting the replacement through Data → Manage).
  // Round 9 was cross-process on a fact the plan HAD asked (`updateReadingAt` arming the
  // #133 lock on the victim), plus a sufficiency failure in the clause round 8 added.
  // Each fix was another re-statement clause in the DELETE, and the argument for "this is
  // the last one" had become a ten-row table.
  //
  // The owner closed the class (#3424, the ruling of 2026-08-22T13:46Z): the victim set is
  // derived from THE STORE, inside the last chunk's `IMMEDIATE` transaction, after that
  // chunk's upserts. A stored day bucket is a victim because a row of its own group is IN
  // THE STORE carrying THIS push's stamp. A row a veto stopped is not stamped, so it
  // justifies nothing — and `edited`, `pushed_at` and the overlap are all read where no
  // other writer can be.
  //
  // SO THESE CASES NO LONGER DRIVE THE PASSES BY HAND. There is no interval between a read
  // and a write to stand in, so the concurrent writer is staged as a TEMP TRIGGER that
  // fires inside an EARLIER CHUNK'S transaction — committed before the last chunk runs,
  // which is the whole window that is left. A trigger rather than a spy for the reason
  // `abortOn` is one: it fires inside the REAL transaction, so what is observed is
  // SQLite's boundary and not a mock's.
  //
  // MUTATION for R8, R9b and every "the veto stopped it" case: in
  // `supersedeMetricSampleOverlaps`, weaken the first query's `AND pushed_at = ?` to
  // `AND pushed_at IS NOT NULL` — "any stored row justifies" instead of "a row THIS push
  // wrote justifies". Each case below then deletes the stored day bucket and reads LOWER
  // than `main`, which is the one thing the invariant forbids outright.

  const NY_DAY = "2026-05-01T04:00:00Z";
  const LA_DAY = "2026-05-01T07:00:00Z";

  /** The pre-push store: one NY-anchored day bucket, stamped by an earlier push. */
  function seedNyDay(p: number, value = 8000): void {
    push(
      p,
      {
        app_version: "1.9.14",
        steps: [steps(NY_DAY, "2026-05-02T04:00:00Z", value)],
      },
      "2026-05-02T05:00:00Z"
    );
    expect(stored(p, "steps").map((r) => r.value)).toEqual([value]);
  }

  function pushChunked(
    p: number,
    records: unknown[],
    timestamp: string,
    chunkSize: number
  ) {
    const parsed = parseHealthConnectPayload(
      { app_version: "1.9.14", steps: records, timestamp },
      "UTC"
    );
    lastParsedDetails = parsed.details;
    return guarded(p, () =>
      ingestHealthConnectPayload(p, parsed, HC, chunkSize)
    );
  }

  /** A write that commits with the chunk that inserts `onStart`, and only that chunk. */
  function raceOn(p: number, onStart: string, body: string): () => void {
    db.exec(
      `CREATE TEMP TRIGGER hc_race AFTER INSERT ON metric_samples
         WHEN NEW.profile_id = ${p} AND NEW.started_at = '${onStart}'
         BEGIN ${body} END`
    );
    return () => db.exec("DROP TRIGGER hc_race");
  }

  it("R8 — keeps the old row when the replacement is TOMBSTONED between chunks", () => {
    // ROUND 8'S DRIVER. The user is on Data → Manage *because* they saw the duplicated
    // day this PR exists to fix, and deletes the re-anchored one of the pair — which
    // writes a #508 tombstone on its exact natural key. The push's re-send of that row is
    // then refused by pass C, so nothing replaces the old-anchoring row.
    //
    // The delete lands in chunk 1's transaction; the tombstone is written before the push
    // because a SQL trigger cannot call `writeImportTombstone` (the natural key carries a
    // NUL separator, which a SQL string literal cannot hold). Which of the two commits
    // first is not the variable — the twin being GONE when chunk 2 reads it is.
    const p = freshProfile("R8-TOMBSTONE-BETWEEN-CHUNKS");
    push(
      p,
      {
        app_version: "1.9.14",
        steps: [
          steps(NY_DAY, "2026-05-02T04:00:00Z", 8000),
          steps(LA_DAY, "2026-05-02T07:00:00Z", 8100),
        ],
      },
      "2026-05-02T05:00:00Z"
    );
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000, 8100]);
    writeImportTombstone(
      p,
      "metric_samples",
      metricSampleTombstoneKey("steps", HC, ORIGIN, LA_DAY)
    );

    // Chunk 1 carries a bucket for a DIFFERENT day, far enough out that it is not itself
    // a candidate for the NY row — so the only thing that could license that delete is
    // the re-anchored row, which never lands.
    const undo = raceOn(
      p,
      "2026-04-28T07:00:00Z",
      `DELETE FROM metric_samples WHERE profile_id = ${p} AND started_at = '${LA_DAY}';`
    );
    let result;
    try {
      result = pushChunked(
        p,
        [
          steps("2026-04-28T07:00:00Z", "2026-04-29T07:00:00Z", 500),
          steps(LA_DAY, "2026-05-02T07:00:00Z", 8100),
        ],
        "2026-05-02T09:00:00Z",
        1
      );
    } finally {
      undo();
    }

    // OLD ONLY. The re-send was suppressed, so nothing carries this push's stamp anywhere
    // near the NY row and nothing justifies removing it. `main` reads 8000 here; so does
    // this. The pre-fix branch read NOTHING.
    expect(result.split.suppressed).toBe(1);
    expect(result.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([500, 8000]);
  });

  it("R8 — still collapses the old row when the replacement DOES land: the control", () => {
    // THE SAME SETUP AND THE SAME PUSH, with the racing delete removed. Without this the
    // case above passes for a rule that collapses nothing at all.
    const p = freshProfile("R8-CONTROL");
    push(
      p,
      {
        app_version: "1.9.14",
        steps: [
          steps(NY_DAY, "2026-05-02T04:00:00Z", 8000),
          steps(LA_DAY, "2026-05-02T07:00:00Z", 8100),
        ],
      },
      "2026-05-02T05:00:00Z"
    );
    const result = pushChunked(
      p,
      [
        steps("2026-04-28T07:00:00Z", "2026-04-29T07:00:00Z", 500),
        steps(LA_DAY, "2026-05-02T07:00:00Z", 8100),
      ],
      "2026-05-02T09:00:00Z",
      1
    );
    expect(result.split.superseded).toBe(1);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([500, 8100]);
  });

  it("R9a — keeps the victim when a per-row EDIT arms the lock between chunks", () => {
    // ROUND 9'S DRIVER, and the one that ended in a hand-corrected reading being deleted.
    // `updateReadingAt` (lib/reading-writes.ts) is reached from the trends metric detail
    // page's per-row Edit; `steps` and `active-calories` are in METRIC_READING_STORE AND
    // in DAY_BUCKET_METRICS. It sets `edited = 1` and does NOT touch `pushed_at`, so the
    // provenance guard never saw it. The user is on that page BECAUSE the day reads high
    // — the symptom this PR exists to surface — and corrects one of the two rows.
    //
    // The edit commits with chunk 2 of 3, which is the window that is left now that the
    // derivation runs in the last chunk. Under the pre-fix construction the plan had read
    // `edited = 0` before chunk 1 and the DELETE never re-stated it.
    //
    // MUTATION: drop the `if (row.edited)` branch in `planSupersede`
    // (lib/metric-window-overlap.ts) and the corrected 12000 is deleted.
    const p = freshProfile("R9A-EDIT-BETWEEN-CHUNKS");
    seedNyDay(p, 12000);
    const victimId = (
      db
        .prepare(
          "SELECT id FROM metric_samples WHERE profile_id = ? AND started_at = ?"
        )
        .get(p, NY_DAY) as { id: number }
    ).id;

    // THE PRODUCTION WRITER, called for real once so this case cannot drift from the way
    // the app actually arms the lock. The trigger below is the same UPDATE, staged where
    // no JS can run: inside chunk 2's transaction.
    expect(
      updateReadingAt(
        p,
        { store: "metric_samples", id: victimId, metric: "steps" },
        12000
      )
    ).toEqual({ ok: true });
    db.prepare("UPDATE metric_samples SET edited = 0 WHERE id = ?").run(
      victimId
    );

    const undo = raceOn(
      p,
      LA_DAY,
      `UPDATE metric_samples SET value = 12000, edited = 1
         WHERE profile_id = ${p} AND id = ${victimId};`
    );
    let result;
    try {
      result = pushChunked(
        p,
        [
          steps("2026-04-30T07:00:00Z", LA_DAY, 7000),
          steps(LA_DAY, "2026-05-02T07:00:00Z", 8100),
          steps("2026-05-02T07:00:00Z", "2026-05-03T07:00:00Z", 900),
        ],
        "2026-05-02T09:00:00Z",
        1
      );
    } finally {
      undo();
    }

    // OLD + NEW. The hand-corrected 12000 is still there, and the day reads HIGH — which
    // the invariant permits and the Review line says out loud. The pre-fix branch read
    // `[7000, 8100, 900]` with `superseded: 1` and `warnings: []`, telling the reader the
    // row had been REPLACED.
    expect(result.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([
      7000, 12000, 8100, 900,
    ]);
    expect(
      (
        db
          .prepare("SELECT edited FROM metric_samples WHERE id = ?")
          .get(victimId) as { edited: number }
      ).edited
    ).toBe(1);
    expect(warningsOf(result)).toContain(overlapsLeftWarning(1));
  });

  it("R9a — collapses the same row when nothing edits it: the control", () => {
    // THE SAME PUSH WITH THE RACE REMOVED, so the case above is pinning the lock rather
    // than a rule that had stopped deleting.
    const p = freshProfile("R9A-CONTROL");
    seedNyDay(p, 12000);
    const result = pushChunked(
      p,
      [
        steps("2026-04-30T07:00:00Z", LA_DAY, 7000),
        steps(LA_DAY, "2026-05-02T07:00:00Z", 8100),
        steps("2026-05-02T07:00:00Z", "2026-05-03T07:00:00Z", 900),
      ],
      "2026-05-02T09:00:00Z",
      1
    );
    expect(result.split.superseded).toBe(1);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([7000, 8100, 900]);
  });

  it("R9b — a NARROW locked twin does not license collapsing the WHOLE day bucket", () => {
    // THE SUFFICIENCY FAILURE IN ROUND 8'S OWN CLAUSE. That clause asked whether A ROW
    // STANDS under the replacement's natural key, and its docstring argued the edit-lock
    // branch was safe because "the day is left holding a reading". "A row stands" does not
    // imply "that row covers what the victim covered": only the #1101 stale retry
    // guarantees it. An edit lock constrains the twin's window not at all.
    //
    // So: the store holds the NY day bucket AND a stored FIFTEEN-MINUTE row at the LA
    // anchoring's exact start. The user corrects the narrow row between chunks; the wide
    // LA bucket is edit-lock vetoed and lands nowhere; the old clause was TRUE on the
    // narrow row and the whole 8000 bucket went. Day 8050 → 50, with `main` reading 8050.
    //
    // The store-derived predicate cannot reach it: what carries this push's stamp near
    // that day is nothing at all, and the narrow row is not a day-bucket window in either
    // role.
    const p = freshProfile("R9B-NARROW-LOCKED-TWIN");
    push(
      p,
      {
        app_version: "1.9.14",
        steps: [
          steps(NY_DAY, "2026-05-02T04:00:00Z", 8000),
          steps(LA_DAY, "2026-05-01T07:15:00Z", 50),
        ],
      },
      "2026-05-02T05:00:00Z"
    );
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000, 50]);

    const undo = raceOn(
      p,
      "2026-04-28T07:00:00Z",
      `UPDATE metric_samples SET edited = 1
         WHERE profile_id = ${p} AND started_at = '${LA_DAY}';`
    );
    let result;
    try {
      result = pushChunked(
        p,
        [
          steps("2026-04-28T07:00:00Z", "2026-04-29T07:00:00Z", 500),
          steps(LA_DAY, "2026-05-02T07:00:00Z", 8100),
        ],
        "2026-05-02T09:00:00Z",
        1
      );
    } finally {
      undo();
    }

    // The whole day bucket survives beside the corrected narrow row: 8050, exactly what
    // `main` reads. The pre-fix branch read 50.
    expect(result.split.edited).toBe(1);
    expect(result.split.superseded).toBe(0);
    expect(stored(p, "steps").map((r) => r.value)).toEqual([500, 8000, 50]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R8b — one record sent twice is one reading.
// ─────────────────────────────────────────────────────────────────────────────

describe("R8b — a push carrying one natural key twice", () => {
  // THE REFUTATION, AND THE SHAPE THAT MADE IT STRUCTURALLY IMPOSSIBLE. The in-push
  // double count was computed over the PAYLOAD and grouped by (metric, origin): two copies
  // of ONE record share a `started_at`, so they overlap totally — and the ON CONFLICT
  // merges them into ONE stored row. The store was right every time; the warning was false
  // and scaled with the number of copies: two copies said "1 reading", three said "2
  // readings", over a store holding one row. It needed a hand-written dedupe to one row
  // per natural key.
  //
  // The count is now taken over the rows carrying this push's stamp — i.e. over the STORE,
  // which holds one row per natural key by construction — so there is nothing left to
  // dedupe and no way to spell the defect. `scripts/hc-origin-overlap-census.ts` already
  // made the same collapse on (metric, origin, started_at) "so a re-sent moving-end
  // snapshot is not reported as an overlap with itself"; here the unique index does it.
  //
  // These cases stay as the guarantee rather than as the guard: the LAST one is the true
  // positive the collapse must not take with it, and it is the one a mutation reaches
  // (drop `row.date` from the grouping key, or the `windowsOverlap` test, and it moves).

  function pushSteps(p: number, records: unknown[], timestamp: string) {
    const parsed = parseHealthConnectPayload(
      { app_version: "1.9.14", steps: records, timestamp },
      "UTC"
    );
    lastParsedDetails = parsed.details;
    return guarded(p, () => ingestHealthConnectPayload(p, parsed, HC, 2));
  }
  const A = steps("2026-05-01T04:00:00Z", "2026-05-02T01:00:00Z", 9000);

  it("says nothing when one record arrives twice", () => {
    const p = freshProfile("R8B-TWICE");
    pushSteps(p, [A, A], "2026-05-02T02:00:00Z");
    expect(stored(p, "steps").map((r) => r.value)).toEqual([9000]);
    expect(warningsOf(null)).toEqual([]);
  });

  it("says nothing when it arrives three times", () => {
    // The count SCALED with the copies, which is what made it obviously a phantom rather
    // than a debatable unit.
    const p = freshProfile("R8B-THRICE");
    pushSteps(p, [A, A, A], "2026-05-02T02:00:00Z");
    expect(stored(p, "steps").map((r) => r.value)).toEqual([9000]);
    expect(warningsOf(null)).toEqual([]);
  });

  it("says nothing when the second copy is the one pass C vetoes", () => {
    // AND THIS IS THE `dayBuckets` COMMENT'S OWN CLAIM, falsified. It said the list holds
    // "the ones that pass C will actually write … counts nothing that never lands". Pass A
    // reads the PRE-PUSH store for both rows of a duplicated key and sees no veto on
    // either; pass C reads the first row's write when it reaches the second and
    // stale-retry vetoes it. The row never landed and was counted anyway. The dedupe is
    // what makes that harmless — not the veto gate.
    const p = freshProfile("R8B-STALE-COPY");
    pushSteps(
      p,
      [A, steps("2026-05-01T04:00:00Z", "2026-05-01T20:00:00Z", 6000)],
      "2026-05-02T02:00:00Z"
    );
    expect(stored(p, "steps").map((r) => r.value)).toEqual([9000]);
    expect(warningsOf(null)).toEqual([]);
  });

  it("still counts two genuine anchorings — the control", () => {
    // THE TRUE POSITIVE THE DEDUPE MUST NOT TAKE WITH IT. Two DIFFERENT natural keys
    // overlapping is ruling item 3's "write both", and it really is two readings summing
    // into one day.
    const p = freshProfile("R8B-CONTROL");
    pushSteps(
      p,
      [steps("2026-05-01T00:00:00Z", "2026-05-01T23:00:00Z", 8000), A],
      "2026-05-02T02:00:00Z"
    );
    expect(stored(p, "steps").map((r) => r.value)).toEqual([8000, 9000]);
    expect(warningsOf(null)).toContain(overlapsLeftWarning(1));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// R10 — the three drivers that emptied a day under OVERLAP ALONE.
// ─────────────────────────────────────────────────────────────────────────────

describe("R10 — a day bucket may only be collapsed on its OWN date", () => {
  // THE REFUTATION, AND IT BROKE THREE WAYS AT ONCE. The store-derived predicate closed
  // the veto class: only a row this push actually WROTE can justify a delete, so a
  // tombstoned, edit-locked, mis-routed or stale-retried row justifies nothing. That is
  // true of the ROW and false of the PUSH — because Health Connect day buckets CHAIN
  // ACROSS DAYS. The re-anchored bucket for the PREVIOUS local day overlaps this day's
  // stored bucket by the zone offset (LA 04-30 [04-30 07:00Z, 05-01 07:00Z) meets NY
  // 05-01 [05-01 04:00Z, 05-02 04:00Z) for three hours), so a push whose replacement for
  // 05-01 was refused still carried something that overlapped 05-01's stored row — and
  // deleted it. The day went to ZERO, permanently, on a SUCCESSFUL push, with
  // `superseded: 1`, `overlapsLeft: 0` and `warnings: []`.
  //
  // THE RULING (#3424, 2026-08-23T00:58Z): cover the DAY. A stored bucket may be deleted
  // only when a stamped bucket of the same group landed ON THE VICTIM'S OWN `date` and
  // overlaps it. Overlap stays a gate — it is what excludes the rollover pair and the
  // same-anchoring neighbours — and the date carries the justification.
  //
  // MUTATION for all three cases, AND IT TAKES BOTH ENCODINGS OF THE `date` TERM. Run,
  // not asserted — over the three Health Connect supersede specs (79 tests):
  //
  //   • `AND date = ?` out of the candidate query in `supersedeMetricSampleOverlaps`
  //     ALONE: 1 failed of 79, and it is the query-plan assertion in
  //     hc-overlap-supersede.test.ts. None of these three drivers moves — before that
  //     assertion existed the run was EXIT=0, 78 passed. The SQL half is a narrowing.
  //   • `row.date !== incoming.date` out of `planSupersede` ALONE: EXIT=1, 1 failed, and
  //     it is hc-overlap-supersede.test.ts:837, not a driver.
  //   • BOTH: EXIT=1, 5 failed — those two plus ALL THREE drivers together, each on the
  //     `guarded` property above; with `guarded` neutered the same mutation still reds
  //     all three on their own assertions (3 failed of 48). So it is not "each restores
  //     exactly one" either: the safety lives in one encoding and both must go.
  //
  // COVER-THE-WINDOW WAS THE OTHER CANDIDATE AND IT WAS REJECTED, which these fixtures
  // also show: no single re-anchored bucket ever CONTAINS the one it replaces —
  // westward it starts later (07:00Z vs 04:00Z), eastward it ends earlier — so a
  // coverage rule would have collapsed nothing here, nor on prod's four doubled pairs.

  function pushAt(
    p: number,
    records: unknown[],
    timestamp: string,
    chunkSize = 2
  ) {
    const parsed = parseHealthConnectPayload(
      { app_version: "1.9.14", steps: records, timestamp },
      "UTC"
    );
    lastParsedDetails = parsed.details;
    return guarded(p, () =>
      ingestHealthConnectPayload(p, parsed, HC, chunkSize)
    );
  }

  /** What Trends reads for one profile-local day. */
  function totalFor(p: number, date: string): number {
    return (
      db
        .prepare(
          `SELECT COALESCE(SUM(value), 0) AS total FROM metric_samples
              WHERE profile_id = ? AND metric = 'steps' AND date = ?`
        )
        .get(p, date) as { total: number }
    ).total;
  }

  /** New York's local day D, as the exporter cuts it. */
  const ny = (day: string, next: string, count: number) =>
    steps(`${day}T04:00:00Z`, `${next}T04:00:00Z`, count);
  /** Los Angeles's local day D. */
  const la = (day: string, next: string, count: number) =>
    steps(`${day}T07:00:00Z`, `${next}T07:00:00Z`, count);

  it("DRIVER 1 — keeps the day when a TOMBSTONE refused its replacement", () => {
    // The round-10 lens's SHAPE, re-authored here from its prose in PR #3438's comment
    // 5381290964 and driven through the real parse + ingest path. It is not the lens's
    // fixture byte for byte and should not be read as one: the lens measured LA 04-30 at
    // 5000 and `{inserted:0, unchanged:1, suppressed:1, superseded:1}`; this uses 5200,
    // so the 04-30 bucket is a write and the counts read `{inserted:1, …}`. What
    // reproduces is the class — a bucket landing on the PREVIOUS date justifying a delete
    // on this one — and the both-halves mutation above reds it.
    const p = freshProfile("R10-TOMBSTONE");
    // 1. New York, stamped.
    pushAt(
      p,
      [
        ny("2026-04-30", "2026-05-01", 5000),
        ny("2026-05-01", "2026-05-02", 11609),
      ],
      "2026-05-02T06:00:00Z"
    );
    expect(totalFor(p, "2026-05-01")).toBe(11609);

    // 2. The user flies west and the first post-switch push states no readable
    //    timestamp — this PR's own "a stampless push supersedes nothing" shape. Both
    //    anchorings are now stored and 05-01 reads high, which is the designed state.
    const stampless = parseHealthConnectPayload(
      { app_version: "1.9.14", steps: [la("2026-05-01", "2026-05-02", 11721)] },
      "UTC"
    );
    lastParsedDetails = stampless.details;
    guarded(p, () => ingestHealthConnectPayload(p, stampless, HC, 2));
    expect(totalFor(p, "2026-05-01")).toBe(23330);

    // 3. The user deletes the re-anchored duplicate in Data → Manage, which writes the
    //    #508 tombstone on that exact natural key.
    db.prepare(
      "DELETE FROM metric_samples WHERE profile_id = ? AND started_at = ?"
    ).run(p, "2026-05-01T07:00:00Z");
    writeImportTombstone(
      p,
      "metric_samples",
      metricSampleTombstoneKey("steps", HC, ORIGIN, "2026-05-01T07:00:00Z")
    );
    expect(totalFor(p, "2026-05-01")).toBe(11609);

    // 4. The next rolling-window push, stamped, carrying BOTH re-anchored buckets. The
    //    05-01 one is refused by the tombstone; the 04-30 one lands and overlaps the
    //    stored NY 05-01 row by three hours. Under overlap alone that deleted it.
    const result = pushAt(
      p,
      [
        la("2026-04-30", "2026-05-01", 5200),
        la("2026-05-01", "2026-05-02", 11721),
      ],
      "2026-05-02T08:00:00Z"
    );
    expect(result.split.suppressed).toBe(1);
    // 05-01 STANDS. This is the assertion round 10 was refuted on.
    expect(totalFor(p, "2026-05-01")).toBe(11609);
    // And the delete the rule DOES make still happens, on the date that was replaced —
    // otherwise this passes by superseding nothing at all.
    expect(result.split.superseded).toBe(1);
    expect(totalFor(p, "2026-04-30")).toBe(5200);
  });

  it("DRIVER 2 — keeps the day when a #1101 STALE RETRY refused its replacement", () => {
    // The same end state through a different veto, which is why the fix cannot be a
    // clause about tombstones. The exporter retries an older snapshot of the NY 05-01
    // bucket — same natural key, an EARLIER `ended_at` — so `isStaleMetricSnapshot`
    // refuses it and the stored row keeps its older stamp. The push's OTHER row, the
    // re-anchored 04-30 bucket, lands and overlaps 05-01 by three hours.
    const p = freshProfile("R10-STALE-RETRY");
    pushAt(
      p,
      [
        ny("2026-04-30", "2026-05-01", 5000),
        steps("2026-05-01T04:00:00Z", "2026-05-01T20:00:00Z", 11609),
      ],
      "2026-05-02T06:00:00Z"
    );
    expect(totalFor(p, "2026-05-01")).toBe(11609);

    const result = pushAt(
      p,
      [
        la("2026-04-30", "2026-05-01", 5200),
        // The delayed retry: same key, an end EIGHT HOURS earlier than what is stored.
        steps("2026-05-01T04:00:00Z", "2026-05-01T12:00:00Z", 8000),
      ],
      "2026-05-02T08:00:00Z"
    );
    // The retry was refused, so it wrote no stamp and justifies nothing…
    expect(result.split.unchanged).toBe(1);
    // …and nothing else may justify a delete on 05-01 either, which is the ruling.
    expect(totalFor(p, "2026-05-01")).toBe(11609);
    expect(result.split.superseded).toBe(1);
    expect(totalFor(p, "2026-04-30")).toBe(5200);
  });

  it("DRIVER 3 — keeps the day at the EASTWARD trailing edge, on a clean push", () => {
    // No veto at all here: every row lands, the push succeeds, and under overlap alone a
    // day still emptied. An ordinary LA → NY move re-cuts each local day three hours
    // EARLIER in UTC, so the NY bucket for 08-19 reaches back into LA's 08-18 — and the
    // exporter's rolling window does not reach far enough back to re-send an 08-18
    // bucket under the new anchoring.
    //
    // Measured by the lens at round 10's head:
    //     SEEDED [08-17:7000, 08-18:9000, 08-19:10000]
    //     AFTER  [08-17:7000, 08-19:10500, 08-20:8800, 08-21:3000]   superseded: 2
    // 08-18's 9000 was gone, with `warnings: []`.
    const p = freshProfile("R10-EASTWARD");
    pushAt(
      p,
      [
        la("2026-08-17", "2026-08-18", 7000),
        la("2026-08-18", "2026-08-19", 9000),
        la("2026-08-19", "2026-08-20", 10000),
      ],
      "2026-08-20T06:00:00Z",
      3
    );
    expect(totalFor(p, "2026-08-18")).toBe(9000);

    const result = pushAt(
      p,
      [
        ny("2026-08-19", "2026-08-20", 10500),
        ny("2026-08-20", "2026-08-21", 8800),
        steps("2026-08-21T04:00:00Z", "2026-08-21T14:00:00Z", 3000),
      ],
      "2026-08-21T15:00:00Z",
      3
    );
    // ONE delete, not two: the 08-19 bucket collapses 08-19's stored row and stops there.
    expect(result.split.superseded).toBe(1);
    expect(totalFor(p, "2026-08-18")).toBe(9000);
    expect(stored(p, "steps").map((r) => `${r.started_at} ${r.value}`)).toEqual(
      [
        "2026-08-17T07:00:00Z 7000",
        "2026-08-18T07:00:00Z 9000",
        "2026-08-19T04:00:00Z 10500",
        "2026-08-20T04:00:00Z 8800",
        "2026-08-21T04:00:00Z 3000",
      ]
    );
    // WHAT IS NOT SAID, and it is the accepted trade rather than an oversight. The kept
    // LA 08-18 row and the new NY 08-19 row genuinely overlap for three hours — but they
    // are filed under DIFFERENT dates, so no day total reads high and there is nothing
    // for Review to name. Reporting it would warn about two days that are both correct.
    expect(warningsOf(result)).toEqual([]);
  });

  it("and the switch day's leading sliver is DROPPED — the loss, stated", () => {
    // THE ACCEPTED LOSS, in the tree rather than only in the docs. When the date IS
    // replaced, the replacement's leading hours go with it: the LA 08-19 bucket starts
    // 07:00Z and the NY 08-19 row it replaces started 04:00Z, so 04:00Z–07:00Z of NY's
    // 08-19 morning is not in the surviving row. The day keeps a reading — a SMALLER one
    // for that span. That is the trade the ruling accepts, and it is why a coverage rule
    // was considered at all.
    const p = freshProfile("R10-SLIVER");
    pushAt(p, [ny("2026-08-19", "2026-08-20", 10000)], "2026-08-20T06:00:00Z");
    const result = pushAt(
      p,
      [la("2026-08-19", "2026-08-20", 9400)],
      "2026-08-20T09:00:00Z"
    );
    expect(result.split.superseded).toBe(1);
    // Lower than it read before, and NOT zero. The invariant is that the date keeps a
    // reading, not that it keeps every hour.
    expect(totalFor(p, "2026-08-19")).toBe(9400);
  });
});

describe("the fixtures state a stamp production would accept", () => {
  it("dates its pushes in the PAST", () => {
    // #3438. This file used to state `timestamp: 2026-09-01`, ten days after the day it
    // was written, so `pushStampFor` refused every one of them and every `push()` above
    // ran with `pushedAt: null` — superseding nothing, and passing its "the rule declined"
    // assertions for a reason that had nothing to do with the guard under test.
    expect(PUSH_BASE).toBeLessThan(Date.now());
    expect(pushStampFor(stampFor(1))).toBe(stampFor(1));
    expect(pushStampFor(stampFor(pushSeq))).toBe(stampFor(pushSeq));
  });
});
