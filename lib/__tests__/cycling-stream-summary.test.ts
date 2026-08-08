import { describe, expect, it } from "vitest";
import {
  POWER_CURVE_DURATIONS,
  powerCurve,
  powerCurveLabel,
  powerZoneTimes,
  parseCyclingStreams,
} from "../cycling-analytics";
import {
  parseCyclingStreamSummary,
  parsePowerZones,
  serializeCyclingStreamSummary,
  streamSummarySignature,
  summarizeCyclingStreams,
  STREAM_SUMMARY_LOGIC_VERSION,
} from "../cycling-stream-summary";

// A minute of riding, one sample a second, with a hard 5-second surge — enough for
// the 5s bucket to differ from the 60s one, and for two zone bands to both fill.
const STREAMS = JSON.stringify({
  time: { data: Array.from({ length: 61 }, (_, i) => i) },
  watts: { data: Array.from({ length: 61 }, (_, i) => (i < 6 ? 400 : 180)) },
});
const ZONES = JSON.stringify([
  { min: 0, max: 200 },
  { min: 201, max: -1 },
]);

describe("summarizeCyclingStreams", () => {
  it("carries exactly what the overview derives, and agrees with the direct computation", () => {
    const summary = summarizeCyclingStreams(STREAMS, ZONES);
    const streams = parseCyclingStreams(STREAMS);

    // The summary is the SAME answer as parsing the blob — the point of #2292 is
    // that the overview stops paying for the parse, not that it learns less.
    expect(summary.powerCurve).toEqual(
      powerCurve(streams).map(({ seconds, watts }) => ({ seconds, watts }))
    );
    expect(summary.powerZoneSeconds).toEqual(
      powerZoneTimes(streams, parsePowerZones(ZONES)).map((z) => z.seconds)
    );
    expect(summary.powerCurve.length).toBeGreaterThan(0);
    expect(summary.powerZoneSeconds.filter((s) => s > 0).length).toBe(2);
  });

  it("stores no presentation text — a label is re-attached from the duration", () => {
    const summary = summarizeCyclingStreams(STREAMS, ZONES);
    for (const point of summary.powerCurve) {
      expect(Object.keys(point).sort()).toEqual(["seconds", "watts"]);
      expect(powerCurveLabel(point.seconds)).toBeTruthy();
    }
    expect(powerCurveLabel(5)).toBe("5 sec");
    expect(powerCurveLabel(7)).toBeNull();
  });

  it("is TOTAL: an unusable payload summarises empty but SIGNED", () => {
    // This is what gives an unsummarisable row a terminal state — it is written
    // once and stops matching the reconcile, instead of being re-parsed forever.
    for (const streams of [null, "", "{}", "not json at all"]) {
      const summary = summarizeCyclingStreams(streams, ZONES);
      expect(summary.sig).toBe(streamSummarySignature());
      expect(summary.powerCurve).toEqual([]);
      expect(summary.powerZoneSeconds).toEqual([]);
    }
    // Streams without a zone snapshot still yield a curve.
    const noZones = summarizeCyclingStreams(STREAMS, null);
    expect(noZones.powerZoneSeconds).toEqual([]);
    expect(noZones.powerCurve.length).toBeGreaterThan(0);
  });
});

describe("streamSummarySignature (the anti-rot guard)", () => {
  it("names the logic version AND the durations the curve was taken at", () => {
    expect(streamSummarySignature()).toBe(
      `${STREAM_SUMMARY_LOGIC_VERSION}:${POWER_CURVE_DURATIONS.map(
        (d) => d.seconds
      ).join(",")}`
    );
  });

  it("changing the durations invalidates every stored summary without a manual bump", () => {
    // The failure this prevents is silent and permanent: add a 30-second bucket and
    // every row on disk keeps answering the previous question. Folding the durations
    // into the signature means nobody has to remember to bump a version.
    const stored = serializeCyclingStreamSummary(
      summarizeCyclingStreams(STREAMS, ZONES)
    );
    expect(parseCyclingStreamSummary(stored)).not.toBeNull();

    const withExtraBucket = JSON.parse(stored) as { sig: string };
    withExtraBucket.sig = `${STREAM_SUMMARY_LOGIC_VERSION}:5,30,60,300,1200`;
    expect(
      parseCyclingStreamSummary(JSON.stringify(withExtraBucket))
    ).toBeNull();

    const olderLogic = JSON.parse(stored) as { sig: string };
    olderLogic.sig = `${STREAM_SUMMARY_LOGIC_VERSION - 1}:${POWER_CURVE_DURATIONS.map((d) => d.seconds).join(",")}`;
    expect(parseCyclingStreamSummary(JSON.stringify(olderLogic))).toBeNull();
  });
});

describe("parseCyclingStreamSummary", () => {
  it("round-trips a summary it produced", () => {
    const summary = summarizeCyclingStreams(STREAMS, ZONES);
    expect(
      parseCyclingStreamSummary(serializeCyclingStreamSummary(summary))
    ).toEqual(summary);
  });

  it("refuses an absent or unreadable summary rather than guessing", () => {
    for (const value of [null, "", "not json", "[]", '"a string"', "7"]) {
      expect(parseCyclingStreamSummary(value)).toBeNull();
    }
  });

  it("drops malformed points instead of poisoning an all-time best with a non-number", () => {
    const parsed = parseCyclingStreamSummary(
      JSON.stringify({
        sig: streamSummarySignature(),
        powerCurve: [
          { seconds: 5, watts: 400 },
          { seconds: 60, watts: "lots" },
          null,
          { watts: 200 },
        ],
        powerZoneSeconds: [10, "20", null, 30],
      })
    );
    expect(parsed?.powerCurve).toEqual([{ seconds: 5, watts: 400 }]);
    expect(parsed?.powerZoneSeconds).toEqual([10, 0, 0, 30]);
  });
});

describe("parsePowerZones", () => {
  it("keeps a finite bound and nulls anything else, so an open top zone survives", () => {
    expect(parsePowerZones(ZONES)).toEqual([
      { min: 0, max: 200 },
      { min: 201, max: -1 },
    ]);
    expect(
      parsePowerZones(JSON.stringify([{ min: "0", max: null }, 7, null]))
    ).toEqual([{ min: null, max: null }]);
    expect(parsePowerZones(null)).toEqual([]);
    expect(parsePowerZones("{}")).toEqual([]);
    expect(parsePowerZones("nope")).toEqual([]);
  });
});
