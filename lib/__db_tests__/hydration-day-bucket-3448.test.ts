// DB INTEGRATION TIER — WHY `hydration_l` IS NOT IN `DAY_BUCKET_METRICS` (#3448).
//
// #3424 / PR #3438 gave the overlap-supersede rule two gates: the metric must be one
// whose Health Connect windows TILE (`DAY_BUCKET_METRICS`), and the observed window must
// be wider than a fine-grained bucket (`isDayBucketWindow`, i.e. longer than
// `SUB_DAILY_WINDOW_MAX_MIN` = 60 minutes). #3448 asks whether the SECOND gate alone
// separates hydration's two behaviours, so `hydration_l` could simply join the list.
//
// IT DOES NOT, and the three rows below are the measurement. `isDayBucketWindow` is a
// SIXTY-MINUTE gate, not a "sub-daily" one, so any hydration record longer than an hour
// clears it — in both roles. Add `hydration_l` to `DAY_BUCKET_METRICS` and case 1 starts
// reading 1.8 (good) while case 2 DELETES the 1.5 L bottle and the day reads 0.5 for 2.0
// drunk (measured on this tree). That is the nutrition failure of the 2026-08-21
// adversarial pass — an 800 kcal meal deleted, a 150 kcal snack inside it kept — with
// water in place of food.
//
// THE PLATFORM SAYS THE SAME THING, which is what makes this a ruling and not a fixture.
// AndroidX states the tiling contract on the covered metrics and on neither excluded one:
// StepsRecord's KDoc is "records shouldn't have overlapping time ... The start time must
// be equal to or greater than the end time of the previous record" (DistanceRecord says
// the second sentence too); HydrationRecord's is "Captures how much water a user drank in
// a single drink", and its ONLY interval validation is
// `require(startTime.isBefore(endTime))` — no maximum duration, no disjointness. So a
// nested pair is a shape the platform permits and a `full`-setting exporter can deliver.
// Sources, read 2026-08-27, under
// raw.githubusercontent.com/androidx/androidx/androidx-main/health/connect/connect-client/
//   src/main/java/androidx/health/connect/client/records/{Hydration,Steps,Distance}Record.kt
//
// SO CASES 1 AND 3 ARE AN ACCEPTED COST, NOT A PASSING GRADE. Case 1 is #3424's prod
// shape: the switch day genuinely reads 3.2 L for 1.8 L drunk, permanently, because no
// later push collapses it. Case 3 is the same defect with a quieter face — a switch that
// moves the nominal day strands the stale bucket on a day of its own, so nothing reads
// high and nothing is reported. Both are fixed by joining `DAY_BUCKET_METRICS`, and
// neither may be bought at the price of case 2.
//
// SYNTHETIC ONLY: fictional profiles, invented volumes, no PHI.

import { describe, it, expect, afterEach } from "vitest";
import { db } from "@/lib/db";
import { parseHealthConnectPayload } from "@/lib/integrations/health-connect";
import { ingestHealthConnectPayload } from "@/lib/integrations/health-connect-ingest";
import { getMetricDailyTotals } from "@/lib/queries";
import {
  getTimezone,
  setTimezone,
  switchProfileTimezone,
} from "@/lib/settings";

const NY = "America/New_York";
const LA = "America/Los_Angeles";
const TOKYO = "Asia/Tokyo";
const HONOLULU = "Pacific/Honolulu";
// One origin app throughout: the supersede group is (profile, metric, source, origin),
// and `dataOrigin` reads `metadata.data_origin` only — a top-level key parses to
// `origin = null`, which is a different (wider) group than this file claims to test.
const ORIGIN = "com.fitbit.FitbitMobile";

interface Rec {
  start_time: string;
  end_time: string;
  liters?: number;
  count?: number;
}

interface Push {
  /** The exporter's `payload.timestamp` — the supersede's only freshness evidence. */
  at: string;
  hydration?: Rec[];
  steps?: Rec[];
  /** The one-tap travel switch, applied BEFORE this push is parsed. */
  switchTo?: string;
}

const withOrigin = (recs: Rec[] | undefined) =>
  (recs ?? []).map((r) => ({ ...r, metadata: { data_origin: ORIGIN } }));

afterEach(() => {
  delete process.env.ALLOS_TEST_NOW;
});

// Both cases run two Health Connect pushes at ascending stamps against one profile and
// read the store back. They differ only in what the pushes carry and where the profile
// is standing, so they are one table.
const CASES: {
  name: string;
  tz: string;
  pushes: Push[];
  /**
   * `[date, litres]` per stored `hydration_l` row, ordered by `started_at`. The DATE is
   * half the point: case 3 is entirely about which profile-local day a stale bucket is
   * filed under, and a litres-only expectation cannot see it.
   */
  storedHydration: [string, number][];
  /** Every row `getMetricDailyTotals` returns, as `[date, litres]`. */
  hydrationTotals: [string, number][];
  /** The same-push steps control, where one is carried. */
  stepsTotals: [string, number][];
}[] = [
  {
    // #3424's prod shape, on hydration. Both anchorings attribute to the same nominal
    // calendar day (NY midnight `04:00Z` and LA midnight `07:00Z` are both 08-20), so
    // the stale bucket and the re-anchored one sum into one profile-local day. Steps
    // rides along in the same pushes and collapses to 11721; hydration does not.
    name: "a re-anchored day bucket across a NY->LA switch — the day reads 3.2 L for 1.8 L drunk, while steps in the SAME pushes collapses to 11721",
    tz: NY,
    pushes: [
      {
        at: "2026-08-20T20:00:05Z",
        hydration: [
          {
            start_time: "2026-08-20T04:00:00Z",
            end_time: "2026-08-20T20:00:00Z",
            liters: 1.4,
          },
        ],
        steps: [
          {
            start_time: "2026-08-20T04:00:00Z",
            end_time: "2026-08-20T20:00:00Z",
            count: 11609,
          },
        ],
      },
      {
        at: "2026-08-20T22:00:05Z",
        switchTo: LA,
        hydration: [
          {
            start_time: "2026-08-20T07:00:00Z",
            end_time: "2026-08-20T22:00:00Z",
            liters: 1.8,
          },
        ],
        steps: [
          {
            start_time: "2026-08-20T07:00:00Z",
            end_time: "2026-08-20T22:00:00Z",
            count: 11721,
          },
        ],
      },
    ],
    storedHydration: [
      ["2026-08-20", 1.4],
      ["2026-08-20", 1.8],
    ],
    hydrationTotals: [["2026-08-20", 3.2]],
    stepsTotals: [["2026-08-20", 11721]],
  },
  {
    // THE REASON THE FIRST ROW IS NOT FIXED. A 1.5 L bottle sipped 09:00-13:00 local and
    // a 0.5 L sports drink logged INSIDE it, 10:00-11:40, arriving on a later push. Both
    // windows are longer than an hour, so `isDayBucketWindow` waves both through; the
    // only thing keeping the bottle alive is that `hydration_l` is not a day-bucket
    // metric. No timezone moves and nothing is anomalous — this is one person drinking
    // twice.
    name: "a drink logged INSIDE another drink — both survive and the day reads the 2.0 L drunk; adding hydration_l to DAY_BUCKET_METRICS deletes the 1.5 L bottle and leaves 0.5",
    tz: NY,
    pushes: [
      {
        at: "2026-05-04T17:05:00Z",
        hydration: [
          {
            start_time: "2026-05-04T13:00:00Z",
            end_time: "2026-05-04T17:00:00Z",
            liters: 1.5,
          },
        ],
      },
      {
        at: "2026-05-04T18:05:00Z",
        hydration: [
          {
            start_time: "2026-05-04T14:00:00Z",
            end_time: "2026-05-04T15:40:00Z",
            liters: 0.5,
          },
        ],
      },
    ],
    storedHydration: [
      ["2026-05-04", 1.5],
      ["2026-05-04", 0.5],
    ],
    hydrationTotals: [["2026-05-04", 2]],
    stepsTotals: [],
  },
  {
    // THE SAME DEFECT WEARING A QUIETER FACE, and #3448 does not name it. A switch big
    // enough to move the NOMINAL day (Tokyo 05-02 -> Honolulu 05-01) does not leave two
    // rows on one date, so nothing reads high on the switch day and `overlapsLeft` — which
    // is scoped to the victim's own `date` — reports nothing either. The 1.4 L is instead
    // stranded on 05-02, a day the traveller had not started yet.
    //
    // WHY IT STRANDS IS THE EXCLUSION ITSELF, through a second door: `resendDay` (#3428)
    // re-derives a re-sent row's `date` only for a row `isSupersedingWindow` calls a
    // re-anchorable day bucket, and `hydration_l` is not one. So the Tokyo attribution is
    // frozen. For steps the same row would be re-dated onto 05-01 and then collapsed —
    // which is why joining `DAY_BUCKET_METRICS` would fix this row too, and why the case
    // against joining has to be strong enough to outweigh two shapes rather than one.
    name: "a large westward switch (Tokyo -> Honolulu) STRANDS the stale bucket on 05-02, so no day reads high and nothing reports it",
    tz: TOKYO,
    pushes: [
      {
        at: "2026-05-01T23:00:05Z",
        hydration: [
          {
            start_time: "2026-05-01T15:00:00Z",
            end_time: "2026-05-01T23:00:00Z",
            liters: 1.4,
          },
        ],
      },
      {
        at: "2026-05-02T01:00:05Z",
        switchTo: HONOLULU,
        hydration: [
          // The rolling ~48 h window re-sends the pre-switch record beside the
          // re-anchored one, which is what gives `resendDay` its chance to re-date.
          {
            start_time: "2026-05-01T15:00:00Z",
            end_time: "2026-05-01T23:00:00Z",
            liters: 1.4,
          },
          {
            start_time: "2026-05-01T10:00:00Z",
            end_time: "2026-05-02T01:00:00Z",
            liters: 1.8,
          },
        ],
      },
    ],
    storedHydration: [
      ["2026-05-01", 1.8],
      ["2026-05-02", 1.4],
    ],
    hydrationTotals: [
      ["2026-05-01", 1.8],
      ["2026-05-02", 1.4],
    ],
    stepsTotals: [],
  },
];

describe("hydration and the day-bucket supersede (#3448)", () => {
  it.each(CASES)(
    "$name",
    ({ tz, pushes, storedHydration, hydrationTotals, stepsTotals }) => {
      const profileId = Number(
        db
          .prepare("INSERT INTO profiles (name) VALUES (?)")
          .run(`HC hydration ${pushes[0].at}`).lastInsertRowid
      );
      setTimezone(profileId, tz);

      let standing = tz;
      for (const push of pushes) {
        // The exporter stamps its own push time; the app's clock only has to be past it
        // for `pushStampFor`'s skew bound to accept it.
        process.env.ALLOS_TEST_NOW = push.at;
        if (push.switchTo) {
          switchProfileTimezone(profileId, push.switchTo, standing);
          standing = push.switchTo;
        }
        ingestHealthConnectPayload(
          profileId,
          parseHealthConnectPayload(
            {
              timestamp: push.at,
              hydration: withOrigin(push.hydration),
              steps: withOrigin(push.steps),
            },
            getTimezone(profileId)
          )
        );
      }

      const rows = db
        .prepare(
          `SELECT date, value FROM metric_samples
            WHERE profile_id = ? AND metric = 'hydration_l'
            ORDER BY started_at`
        )
        .all(profileId) as { date: string; value: number }[];
      expect(rows.map((r) => [r.date, r.value])).toEqual(storedHydration);

      const totals = (metric: string) =>
        getMetricDailyTotals(profileId, metric).map((t) => [t.date, t.value]);
      expect(totals("hydration_l")).toEqual(hydrationTotals);
      expect(totals("steps")).toEqual(stepsTotals);
    }
  );
});
