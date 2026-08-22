// DB INTEGRATION TIER — THE PROPERTY, NOT THE INSTANCES (#3424).
//
// WHAT THIS FILE IS FOR. The overlap-supersede was refuted five times, and twice by the
// same shape: a push whose final store state depended on the order its rows were walked
// in. Round 1 reached it through a chunk split; round 5 through the natural-key twin the
// upsert loop reads, after the safety comment had claimed the case was closed. Both
// times the fix was a guard on the channel that had just been demonstrated, and both
// times a channel nobody had enumerated produced the same outcome: a day reading LOW,
// `warnings: []`, and the correct row destroyed.
//
// So this file does not test channels. The owner's ruling (option 2 on #3424) replaced
// the construction with three passes:
//
//   A  plan, read-only, over the PRE-PUSH store, over the WHOLE push, before `chunk()`
//   B  apply the deletes, once
//   C  the upsert loop, with no supersede logic in it at all
//
// whose correctness argument is one line — final store = (pre-store − victims) ⊕ upserts,
// with `victims` a pure function of the pre-store and the push. That line says the final
// store is independent of row order and chunking BY CONSTRUCTION. This file is that line
// as an executable claim: the SAME push, against the SAME non-empty store, driven
// through every ordering and chunk size below, must leave byte-identical rows and an
// identical split every time.
//
// WHICH KNOB DOES WHICH WORK, stated rather than implied. `ingestHealthConnectPayload`
// sorts the parsed samples by `started_at` before chunking, and `upsertMetricSamples`
// sorts again, so a permutation of rows with distinct starts is normalised by the
// pipeline itself — those orderings pin that the sort is TOTAL and STABLE, which is worth
// pinning but is not the interesting half. THE CHUNK SIZE IS. It is the one knob that
// changes where a transaction boundary falls and what a later row can observe, and it is
// the channel round 1 actually used. A one-row chunk is included for that reason.
//
// And because the argument is about a PURE FUNCTION, the plan itself is asserted
// directly on permuted inputs at the end — no sort is involved there at all.
//
// EVERY SEED HERE IS NON-EMPTY. That is the correction the owner's ruling made explicit:
// all five earlier "both anchorings" cases pushed into a `freshProfile`, where "both rows
// are stored" is what two plain inserts do and the rule is never asked anything. It is
// why five review rounds could each believe ruling item 3 was pinned.
//
// SYNTHETIC ONLY: fictional profiles, invented step counts, no PHI.

import { describe, expect, it } from "vitest";
import { db } from "@/lib/db";
import { parseHealthConnectPayload } from "@/lib/integrations/health-connect";
import { ingestHealthConnectPayload } from "@/lib/integrations/health-connect-ingest";
import {
  supersedeMetricSampleOverlaps,
  upsertMetricSamples,
} from "@/lib/integrations/normalize";
import { writeTx } from "@/lib/db";
import { recordUnstampedEra } from "@/lib/integrations/unstamped-era";
import { writeImportTombstone } from "@/lib/integrations/tombstones";
import { metricSampleTombstoneKey } from "@/lib/integrations/tombstone-keys";
import {
  UNSTAMPED_ERA_AT_KEY,
  UNSTAMPED_ERA_MAX_ID_KEY,
} from "@/lib/metric-window-overlap";
import type { UpsertCounts } from "@/lib/integrations/sync-log";
import { setTimezone } from "@/lib/settings";

const HC = "health-connect";
const ORIGIN = "com.fitbit.FitbitMobile";
const ORIGIN_META = { metadata: { data_origin: ORIGIN } };

function freshProfile(name: string): number {
  const id = Number(
    db.prepare("INSERT INTO profiles (name) VALUES (?)").run(name)
      .lastInsertRowid
  );
  setTimezone(id, "UTC");
  return id;
}

// ── the payload vocabulary ────────────────────────────────────────────────────
// The four day-bucket metrics, under the payload keys the exporter actually sends.
type Rec = Record<string, unknown>;
const bucket =
  (valueKey: string) =>
  (start_time: string, end_time: string, value: number): Rec => ({
    start_time,
    end_time,
    [valueKey]: value,
    ...ORIGIN_META,
  });
const stepsRec = bucket("count");
const distRec = bucket("meters");
const activeRec = bucket("calories");

/** A pre-column row: NULL `pushed_at`, exactly as every row written before deploy is. */
function seedUnstamped(
  profileId: number,
  metric: string,
  started_at: string,
  ended_at: string,
  value: number
): void {
  db.prepare(
    `INSERT INTO metric_samples
       (profile_id, source, origin, metric, date, started_at, ended_at, value)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    profileId,
    HC,
    ORIGIN,
    metric,
    started_at.slice(0, 10),
    started_at,
    ended_at,
    value
  );
}

/**
 * Move the era markers so everything seeded so far counts as PRE-existing.
 *
 * A test database is migrated with `metric_samples` empty, so the real marker is `id = 0`
 * and nothing a test seeds could ever be pre-era. Restating it is what makes the
 * DEPLOY-DAY state reachable at all.
 */
function eraAfterEverything(startedAt: string): void {
  const maxId =
    (
      db.prepare("SELECT MAX(id) AS m FROM metric_samples").get() as {
        m: number | null;
      }
    ).m ?? 0;
  db.prepare("DELETE FROM settings WHERE key IN (?, ?)").run(
    UNSTAMPED_ERA_AT_KEY,
    UNSTAMPED_ERA_MAX_ID_KEY
  );
  recordUnstampedEra(startedAt, maxId);
}

function ingest(
  profileId: number,
  body: Rec,
  chunkSize: number
): { split: UpsertCounts; warnings: string[] } {
  const parsed = parseHealthConnectPayload(body, "UTC");
  const split = ingestHealthConnectPayload(
    profileId,
    parsed,
    HC,
    chunkSize
  ).split;
  return { split, warnings: parsed.details.warnings };
}

// ── the snapshot the comparison is made on ────────────────────────────────────
//
// TWO SNAPSHOTS, AND KEEPING THEM APART IS THE POINT.
//
//   `content` is every column the push can touch, read in a canonical order. THIS is the
//   store, and this is what the correctness argument claims is independent of row order
//   and chunking. It must hold whether or not anything sorts.
//
//   `writeOrder` is the same rows keyed by their rank in `id` order — a fact about which
//   physical order they were written in, which is what the ascending-`started_at` sort
//   delivers and the ONLY thing it delivers. Measured: with the three passes in place and
//   both sorts removed, `content` is byte-identical across every ordering and chunk size
//   and only `writeOrder` moves. That is the owner's ruling made executable — the sort is
//   deterministic write order and NOT what makes the store correct — and it is why these
//   are two assertions with two messages rather than one. Folding the rank into the
//   content comparison would report "a different store" for a diff that is nothing of the
//   kind, and send the next reader hunting a data defect that is not there.
//
// `id` is a rank rather than a value because each run uses its own profile, so absolute
// ids differ by construction.
interface Row {
  metric: string;
  source: string;
  origin: string | null;
  date: string;
  started_at: string;
  ended_at: string;
  value: number;
  edited: number | null;
  pushed_at: string | null;
}

function snapshot(profileId: number): {
  content: Row[];
  writeOrder: string[];
} {
  const byId = db
    .prepare(
      `SELECT metric, source, origin, date, started_at, ended_at, value, edited,
              pushed_at
         FROM metric_samples WHERE profile_id = ? ORDER BY id`
    )
    .all(profileId) as Row[];
  return {
    content: [...byId].sort(
      (a, b) =>
        a.metric.localeCompare(b.metric) ||
        String(a.origin).localeCompare(String(b.origin)) ||
        a.started_at.localeCompare(b.started_at)
    ),
    writeOrder: byId.map((r) => `${r.metric}@${r.started_at}`),
  };
}

// ── the orderings ─────────────────────────────────────────────────────────────
// Permutations of the payload's records, applied to every metric array and to the order
// of the metric keys themselves — the two things an exporter could plausibly vary.
const ORDERINGS = {
  "as sent": <T>(xs: T[]) => xs,
  reversed: <T>(xs: T[]) => [...xs].reverse(),
  interleaved: <T>(xs: T[]) => [
    ...xs.filter((_, i) => i % 2 === 1),
    ...xs.filter((_, i) => i % 2 === 0),
  ],
} as const;

function reorder(body: Rec, permute: <T>(xs: T[]) => T[]): Rec {
  const keys = permute(Object.entries(body));
  return Object.fromEntries(
    keys.map(([k, v]) => [k, Array.isArray(v) ? permute(v) : v])
  );
}

// Includes 1 — the case the ruling names — and a size larger than any push here, so the
// no-split path is one of the runs being compared rather than the baseline's privilege.
const CHUNK_SIZES = [1, 2, 3, 500];

// ── the four seeds ────────────────────────────────────────────────────────────

const NY_19 = ["2026-08-19T04:00:00Z", "2026-08-20T04:00:00Z"] as const;
const NY_20 = ["2026-08-20T04:00:00Z", "2026-08-21T02:11:00Z"] as const;
const LA_19 = ["2026-08-19T07:00:00Z", "2026-08-20T07:00:00Z"] as const;
const LA_20 = ["2026-08-20T07:00:00Z", "2026-08-21T03:05:00Z"] as const;

interface Scenario {
  name: string;
  /** Everything in the store before the push. Must leave at least one row. */
  seed: (profileId: number) => void;
  /** The push, as the exporter would send it. */
  body: Rec;
  /**
   * The rows the store must hold afterwards, as `metric@started_at` in `content` order.
   *
   * OPTIONAL, AND NOT DECORATION (#3438). Everything else here is a comparison BETWEEN
   * runs, which goes green whenever the outcome is wrong the same way every time — and
   * round 7's refutation was exactly that: a stored reading deleted, identically, at
   * every chunk size. A scenario whose point is that a particular row SURVIVES says so
   * absolutely.
   */
  survivors?: string[];
}

const SCENARIOS: Scenario[] = [
  {
    // THE PROD SWITCH PAIR. #3424's own incident: the store holds the New York day
    // buckets, the phone switches to Los Angeles, and the next push carries nothing but
    // the new anchoring. The stored rows are the victims, and there are two days of them
    // plus two metrics, so the chunk boundary has somewhere to fall.
    name: "the prod switch pair — NY stored, LA pushed",
    seed: (p) => {
      ingest(
        p,
        {
          timestamp: "2026-08-21T01:00:00Z",
          app_version: "1.9.14",
          steps: [stepsRec(...NY_19, 9000), stepsRec(...NY_20, 11609)],
          distance: [distRec(...NY_19, 7100), distRec(...NY_20, 9200)],
        },
        500
      );
    },
    body: {
      timestamp: "2026-08-21T03:05:00Z",
      app_version: "1.9.14",
      steps: [stepsRec(...LA_19, 9100), stepsRec(...LA_20, 11721)],
      distance: [distRec(...LA_19, 7180), distRec(...LA_20, 9300)],
    },
  },
  {
    // THE RE-ANCHORED HISTORICAL BUCKET BESIDE THE CURRENT ONE. The owner measured this
    // in the retained payloads: the 08-19 `active_calories` bucket arrives RE-CUT under
    // the new zone in the same push as the still-filling 08-20 one. The historical bucket
    // is COMPLETED, so it ends EARLIER than the stored row it corrects — which is exactly
    // the pair an `ended_at` ranking read backwards, storing 3000 for 3500 walked.
    name: "a re-anchored historical bucket beside the current one",
    seed: (p) => {
      ingest(
        p,
        {
          timestamp: "2026-08-21T01:00:00Z",
          app_version: "1.9.14",
          active_calories: [activeRec(...NY_19, 298), activeRec(...NY_20, 401)],
          steps: [stepsRec(...NY_20, 11609)],
        },
        500
      );
    },
    body: {
      timestamp: "2026-08-21T03:05:00Z",
      app_version: "1.9.14",
      active_calories: [activeRec(...LA_19, 305), activeRec(...LA_20, 410)],
      steps: [stepsRec(...LA_20, 11721)],
    },
  },
  {
    // THE QUEUED STALE RETRY — B3's shape. The store is the deploy-day state: BOTH
    // anchorings, BOTH stamps NULL, both pre-era. A push the phone made BEFORE the column
    // landed drains late and re-delivers the pre-switch record. It must take nothing — its
    // stamp predates the era — and what it leaves is the store ASYMMETRICALLY stamped: the
    // STALE row now carries a stamp and the CORRECT one is still NULL. That asymmetry is
    // now PERMANENT: #3439 would have replayed the rule over stored history in `id` order
    // and is closed as not planned, so nothing walks these rows again. The day keeps
    // reading high, visibly, which is why the rule declines rather than guesses.
    name: "the queued stale retry against a deploy-day store",
    seed: (p) => {
      seedUnstamped(p, "steps", ...NY_20, 11609);
      seedUnstamped(p, "steps", ...LA_20, 11721);
      seedUnstamped(p, "distance_km", ...NY_20, 9.2);
      seedUnstamped(p, "distance_km", ...LA_20, 9.3);
      eraAfterEverything("2026-08-21T00:00:00Z");
    },
    body: {
      timestamp: "2026-08-20T20:00:05Z",
      app_version: "1.9.14",
      steps: [stepsRec(...NY_20, 11609)],
      distance: [distRec(...NY_20, 9200)],
    },
  },
  {
    // ROUND 5'S SHAPE, AND THE ONE THAT MAKES THE CONTENT ASSERTION BITE. A stale retry
    // of a NULL-stamped pre-era row arrives in the same push as the re-anchored bucket
    // that overlaps it.
    //
    // Under the three passes the stored row is a natural key of this push, so it is never
    // a victim: the retry finds its twin, `isStaleMetricSnapshot` holds the converged
    // value, and the re-anchored bucket is written beside it. Under the per-row rule the
    // outcome depended entirely on which row the loop reached first — the re-anchored
    // bucket first DELETED the twin, so the retry's `found` came back undefined,
    // `staleRetry` flipped to false and THE STALE VALUE WAS WRITTEN; the retry first and
    // the row was held, then deleted, and the reading vanished. Three orders, three
    // different stores, all with `warnings: []`.
    name: "a stale retry beside the re-anchored bucket that overlaps it",
    seed: (p) => {
      seedUnstamped(p, "steps", ...NY_20, 11609);
      seedUnstamped(p, "distance_km", ...NY_20, 9.2);
      eraAfterEverything("2026-08-21T00:00:00Z");
    },
    body: {
      timestamp: "2026-08-21T03:05:00Z",
      app_version: "1.9.14",
      // The retry: same natural key, an END that stopped EARLIER, a smaller value.
      steps: [
        stepsRec("2026-08-20T04:00:00Z", "2026-08-20T20:00:00Z", 9000),
        stepsRec(...LA_20, 11721),
      ],
      distance: [
        distRec("2026-08-20T04:00:00Z", "2026-08-20T20:00:00Z", 7300),
        distRec(...LA_20, 9300),
      ],
    },
  },
  {
    // A TOMBSTONE IN THE PUSH'S PATH — round 7's refutation, as a property rather than an
    // instance (#3438). The store holds the NY anchoring. The user deleted the
    // LA-anchored duplicate for 08-19 through Data → Manage, which writes a
    // `metric_samples` tombstone on that exact `started_at`, and the rolling window
    // re-sends it anyway. Pass C is FORBIDDEN to write that row, so pass A must plan no
    // delete for the NY row it overlaps — while the 08-20 pair, which nothing forbids,
    // still collapses. Both halves in one push, so a chunk boundary falls between them.
    //
    // This file never seeded a tombstone before, which is why the doc's stand-in for the
    // whole identity could not see the defect either.
    name: "a re-anchored bucket the #508 tombstone forbids",
    seed: (p) => {
      ingest(
        p,
        {
          timestamp: "2026-08-21T01:00:00Z",
          app_version: "1.9.14",
          steps: [stepsRec(...NY_19, 9000), stepsRec(...NY_20, 11609)],
          distance: [distRec(...NY_19, 7100), distRec(...NY_20, 9200)],
        },
        500
      );
      for (const metric of ["steps", "distance_km"])
        writeImportTombstone(
          p,
          "metric_samples",
          metricSampleTombstoneKey(metric, HC, ORIGIN, LA_19[0])
        );
    },
    body: {
      timestamp: "2026-08-21T03:05:00Z",
      app_version: "1.9.14",
      steps: [stepsRec(...LA_19, 9100), stepsRec(...LA_20, 11721)],
      distance: [distRec(...LA_19, 7180), distRec(...LA_20, 9300)],
    },
    // The forbidden LA 08-19 row lands nowhere and the NY 08-19 row it would have
    // replaced is still there; the 08-20 pair, which nothing forbids, collapses.
    survivors: [
      "distance_km@2026-08-19T04:00:00Z",
      "distance_km@2026-08-20T07:00:00Z",
      "steps@2026-08-19T04:00:00Z",
      "steps@2026-08-20T07:00:00Z",
    ],
  },
  {
    // A MIXED-ANCHORING PUSH AGAINST A STORE THAT ALREADY HOLDS ONE OF THE TWO — the
    // configuration ruling item 3 governs, and the one none of the five `freshProfile`
    // tests ever reached. The stored NY row is BOTH a row this push re-sends AND a row
    // this push's LA bucket overlaps and outranks. Under the per-row rule it was deleted
    // by the LA bucket and re-inserted (or not) depending on which the loop reached
    // first; the plan excludes every natural key of the push from being a victim, so it
    // survives whatever the order, and the day reading high is reported instead.
    name: "a mixed-anchoring push over a store holding one of the two",
    seed: (p) => {
      ingest(
        p,
        {
          timestamp: "2026-08-21T01:00:00Z",
          app_version: "1.9.14",
          steps: [stepsRec(...NY_20, 11609)],
          distance: [distRec(...NY_20, 9200)],
        },
        500
      );
    },
    body: {
      timestamp: "2026-08-21T03:05:00Z",
      app_version: "1.9.14",
      steps: [stepsRec(...NY_20, 11609), stepsRec(...LA_20, 11721)],
      distance: [distRec(...NY_20, 9200), distRec(...LA_20, 9300)],
    },
  },
];

describe("the same push leaves the same store, whatever the order and the chunking", () => {
  it.each(SCENARIOS.map((s) => [s.name, s] as const))(
    "%s",
    (_name, scenario) => {
      const runs: {
        label: string;
        content: Row[];
        writeOrder: string[];
        split: UpsertCounts;
        warnings: string[];
      }[] = [];

      for (const [orderName, permute] of Object.entries(ORDERINGS)) {
        for (const chunkSize of CHUNK_SIZES) {
          const label = `${orderName} @ chunk ${chunkSize}`;
          const p = freshProfile(`PROP ${scenario.name} ${label}`);
          scenario.seed(p);
          // THE STORE IS NON-EMPTY BEFORE THE PUSH. Asserted per run, not once: a seed
          // that silently stopped seeding would make every comparison below true of an
          // empty table, and an equality between two empty sets is the failure mode this
          // whole file exists to not have.
          const seeded = (
            db
              .prepare(
                "SELECT COUNT(*) AS n FROM metric_samples WHERE profile_id = ?"
              )
              .get(p) as { n: number }
          ).n;
          expect(seeded).toBeGreaterThan(0);

          const { split, warnings } = ingest(
            p,
            reorder(scenario.body, permute),
            chunkSize
          );
          runs.push({ label, ...snapshot(p), split, warnings });
        }
      }

      const baseline = runs[0];
      // AND THE COMPARISON EXAMINED SOMETHING. A presence assertion about byte-identical
      // rows only fails loudly if there were rows; this says so before believing it.
      expect(baseline.content.length).toBeGreaterThan(0);
      if (scenario.survivors)
        expect(
          baseline.content.map((r) => `${r.metric}@${r.started_at}`)
        ).toEqual(scenario.survivors);
      expect(runs.length).toBe(
        Object.keys(ORDERINGS).length * CHUNK_SIZES.length
      );

      for (const run of runs.slice(1)) {
        // THE STORE. Byte-identical rows, every column the push can touch. This is the
        // claim `final store = (pre-store − victims) ⊕ upserts` makes, and nothing about
        // it depends on either sort.
        expect(
          run.content,
          `${run.label} left a different store than ${baseline.label}`
        ).toEqual(baseline.content);
        // THE WRITE ORDER, which is a separate and weaker claim: the ascending sort makes
        // `metric_samples.id` follow the day for anyone reading the table by hand. A
        // failure HERE means the sort stopped being global — not that a reading moved.
        expect(
          run.writeOrder,
          `${run.label} wrote the rows in a different order than ${baseline.label} — the sort, not the store`
        ).toEqual(baseline.writeOrder);
        // Identical counts — the split a person reads in Review, including `superseded`.
        expect(run.split, `${run.label} reported a different split`).toEqual(
          baseline.split
        );
        // And the same thing said out loud, or not said, either way.
        expect(run.warnings, `${run.label} warned differently`).toEqual(
          baseline.warnings
        );
      }
    }
  );

  it("derives the victim set from the STORE, with no payload in hand at all", () => {
    // THE CLAIM THE WHOLE CONSTRUCTION NOW RESTS ON, asserted with nothing to permute.
    // The owner's ruling of 2026-08-22 took the plan off the payload: a stored day bucket
    // is a victim because a row of its own group is IN THE STORE carrying this push's
    // stamp, and for no other reason. So the predicate can be handed a profile, a source
    // and a stamp — no rows, no order, no chunk boundary — and must still collapse
    // exactly what the ingest collapses. There is nothing left for an ordering to move.
    //
    // MUTATION: pass anything payload-shaped back into `supersedeMetricSampleOverlaps`
    // and this call has nothing to give it.
    const p = freshProfile("PROP STORE-DERIVED");
    ingest(
      p,
      {
        timestamp: "2026-08-21T01:00:00Z",
        app_version: "1.9.14",
        steps: [stepsRec(...NY_19, 9000), stepsRec(...NY_20, 11609)],
      },
      500
    );
    // The re-anchored push lands its rows and is then PREVENTED from superseding, by
    // running it through the upsert half only — so the store is exactly what the last
    // chunk's transaction sees just before the derivation runs.
    const stamp = "2026-08-21T03:05:00Z";
    const rows = parseHealthConnectPayload(
      {
        timestamp: stamp,
        app_version: "1.9.14",
        steps: [
          stepsRec(...NY_20, 11609),
          stepsRec(...LA_19, 9100),
          stepsRec(...LA_20, 11721),
        ],
      },
      "UTC"
    ).samples;
    expect(rows.length).toBe(3);
    writeTx(() => upsertMetricSamples(p, rows, HC, undefined, { pushedAt: stamp }));
    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM metric_samples WHERE profile_id = ?"
        )
        .get(p)
    ).toEqual({ n: 4 });

    // NO PAYLOAD. Three arguments, none of which is a row.
    const outcome = writeTx(() => supersedeMetricSampleOverlaps(p, HC, stamp));
    // The NY 08-19 bucket is collapsed by the re-anchored LA 08-19 one. The NY 08-20 row
    // is a row this push re-sent, so it carries the stamp and is nobody's victim — it
    // overlaps the LA 08-20 bucket, and that is the day reading high the line reports.
    expect(outcome.removed).toBe(1);
    expect(outcome.overlapsLeft).toBe(1);
    expect(
      (
        db
          .prepare(
            "SELECT started_at FROM metric_samples WHERE profile_id = ? ORDER BY started_at"
          )
          .all(p) as { started_at: string }[]
      ).map((r) => r.started_at)
    ).toEqual([LA_19[0], NY_20[0], LA_20[0]].sort());

    // AND IT IS IDEMPOTENT UNDER THE SAME STAMP, which is the same claim from the other
    // side: everything the predicate can justify has already been done.
    expect(writeTx(() => supersedeMetricSampleOverlaps(p, HC, stamp)).removed).toBe(0);
  });
});
