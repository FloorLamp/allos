import { describe, expect, it } from "vitest";
import { parseSleepJson } from "@/lib/integrations/fitbit-takeout";
import { parseHealthConnectPayload } from "@/lib/integrations/health-connect";
import { mapOuraSleep } from "@/lib/integrations/oura";
import { mapWithingsSleep } from "@/lib/integrations/withings";
import type { NormMetricSample } from "@/lib/integrations/normalize";

// A stored sleep session is an ABSOLUTE INSTANT, full stop — the invariant #2096
// broke and this file exists to keep from breaking again silently.
//
// It is not a stylistic preference. `metric_samples.start_time` is (a) the natural
// upsert key for the row, and (b) the value every read path hands to `new Date()` to
// reconstruct a bed/wake clock. A zoneless wall clock survives (a) fine and fails (b)
// catastrophically: ECMAScript resolves an offset-less date-time in the PROCESS zone,
// so the moment the row denotes becomes a property of the container's `TZ` rather
// than of the data. On the Fitbit Takeout path that moved a profile's derived typical
// wake time by four hours between `TZ=UTC` (what Docker ships) and the profile's own
// zone, and moved the night count too, as sessions re-bucketed across the wake-day
// boundary.
//
// So the check below is per-PARSER rather than per-reader: a reader cannot repair a
// stamp that arrived without a zone, and there is no read-side place to put the fix.
// Every sleep-emitting ingest path gets the vendor's real payload shape and must emit
// a boundary carrying `Z` or an explicit offset. A new provider (Garmin is registered
// and unimplemented) fails here rather than in a wake-time bug report.
const ABSOLUTE = /(Z|[+-]\d{2}:?\d{2})$/i;

const TZ = "America/New_York";

// A stage row's start_time carries a `#<stage>` discriminator so the four stages of
// one night do not collide on the shared window key; the instant is the part before
// it.
function instants(samples: NormMetricSample[]): string[] {
  const sleep = samples.filter((s) => s.metric.startsWith("sleep_"));
  expect(sleep.length).toBeGreaterThan(0);
  return sleep.flatMap((s) => [s.start_time.split("#")[0], s.end_time]);
}

describe("every sleep parser writes an absolute instant", () => {
  it("fitbit-takeout — a ZONELESS vendor wall clock, resolved in the profile zone", () => {
    const out = parseSleepJson(
      JSON.stringify([
        {
          logId: 1,
          dateOfSleep: "2026-07-26",
          startTime: "2026-07-25T23:14:30.000",
          endTime: "2026-07-26T06:11:30.000",
          duration: 417 * 60000,
          type: "stages",
          levels: {
            summary: {
              deep: { minutes: 58 },
              wake: { minutes: 91 },
              light: { minutes: 245 },
              rem: { minutes: 23 },
            },
          },
        },
      ]),
      TZ
    );
    for (const t of instants(out.samples)) expect(t).toMatch(ABSOLUTE);
  });

  it("health-connect — instants from the exporter", () => {
    const out = parseHealthConnectPayload(
      {
        sleep: [
          {
            start_time: "2026-06-14T23:00:00Z",
            end_time: "2026-06-15T07:00:00Z",
            stages: [
              {
                stage: "deep",
                start_time: "2026-06-14T23:00:00Z",
                end_time: "2026-06-15T01:00:00Z",
              },
            ],
          },
        ],
      },
      TZ
    );
    for (const t of instants(out.samples)) expect(t).toMatch(ABSOLUTE);
  });

  it("oura — offset-bearing bedtimes from the API", () => {
    const res = mapOuraSleep({
      id: "sleep-1",
      day: "2024-05-02",
      type: "long_sleep",
      bedtime_start: "2024-05-01T23:10:00-07:00",
      bedtime_end: "2024-05-02T07:10:00-07:00",
      total_sleep_duration: 27000,
      deep_sleep_duration: 5400,
    });
    for (const t of instants(res!.samples)) expect(t).toMatch(ABSOLUTE);
  });

  it("withings — epoch seconds, serialized as UTC", () => {
    const res = mapWithingsSleep(
      {
        id: 55501,
        timezone: TZ,
        startdate: 1699920000,
        enddate: 1699945200,
        date: "2023-11-14",
        data: {
          deepsleepduration: 5400,
          lightsleepduration: 14400,
          remsleepduration: 5400,
          wakeupduration: 1800,
        },
      },
      "UTC"
    );
    for (const t of instants(res!.samples)) expect(t).toMatch(ABSOLUTE);
  });
});
