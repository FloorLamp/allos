import { describe, expect, it } from "vitest";
import {
  cyclingLoad,
  distanceSplits,
  powerCurve,
  powerZoneTimes,
  rideDynamics,
  rideTimedRoutePoints,
  rideTraces,
  routeFingerprint,
} from "@/lib/cycling-analytics";

function stream(data: unknown[]) {
  return { data };
}

describe("cycling telemetry analytics", () => {
  it("builds chart traces and converts the Strava speed stream to km/h", () => {
    const traces = rideTraces({
      time: stream([0, 1, 2]),
      velocity_smooth: stream([5, 6, 7]),
      watts: stream([100, 200, 300]),
    });
    expect(traces.map((trace) => trace.key)).toEqual([
      "watts",
      "velocity_smooth",
    ]);
    expect(traces[1].points[0]).toEqual({ date: "0:00", value: 18 });
  });

  it("aligns valid route coordinates with elapsed stream time", () => {
    expect(
      rideTimedRoutePoints({
        time: stream([0, 10, 20, 30]),
        latlng: stream([[38.5, -120.2], [38.6, -120.3], null, [38.8, -120.5]]),
      })
    ).toEqual([
      { elapsedSec: 0, lat: 38.5, lng: -120.2 },
      { elapsedSec: 10, lat: 38.6, lng: -120.3 },
      { elapsedSec: 30, lat: 38.8, lng: -120.5 },
    ]);
  });

  it("computes the standard best-effort durations that fit the stream", () => {
    const times = Array.from({ length: 302 }, (_, index) => index);
    const watts = times.map((index) => (index < 60 ? 300 : 200));
    expect(powerCurve({ time: stream(times), watts: stream(watts) })).toEqual([
      { seconds: 5, label: "5 sec", watts: 300 },
      { seconds: 60, label: "1 min", watts: 300 },
      { seconds: 300, label: "5 min", watts: 220 },
    ]);
  });

  it("derives FTP-relative intensity and duration-scaled training load", () => {
    expect(cyclingLoad(250, 200, 60)).toEqual({
      ftpW: 250,
      weightedPowerW: 200,
      intensityFactor: 0.8,
      trainingLoad: 64,
    });
  });

  it("derives moving, stopped, coasting, climbing, and power/HR drift", () => {
    const times = Array.from({ length: 121 }, (_, index) => index);
    const dynamics = rideDynamics({
      time: stream(times),
      moving: stream(times.map((index) => index < 11 || index > 20)),
      watts: stream(
        times.map((index) => (index >= 31 && index <= 40 ? 0 : 200))
      ),
      grade_smooth: stream(
        times.map((index) => (index >= 41 && index <= 60 ? 4 : 0))
      ),
      heartrate: stream(times.map((index) => (index <= 60 ? 100 : 110))),
    });
    expect(dynamics).toEqual({
      movingSeconds: 110,
      stoppedSeconds: 10,
      coastingSeconds: 10,
      coastingPercent: 9,
      climbingSeconds: 20,
      climbingPercent: 18,
      powerHrDriftPercent: 9.1,
    });
  });

  it("calculates time in configured power zones", () => {
    expect(
      powerZoneTimes(
        {
          time: stream([0, 1, 2, 3, 4]),
          watts: stream([0, 100, 200, 300, 400]),
        },
        [
          { min: 0, max: 199 },
          { min: 200, max: 299 },
          { min: 300, max: -1 },
        ]
      )
    ).toEqual([
      { zone: 1, min: 0, max: 199, seconds: 1, percent: 25 },
      { zone: 2, min: 200, max: 299, seconds: 1, percent: 25 },
      { zone: 3, min: 300, max: -1, seconds: 2, percent: 50 },
    ]);
  });

  it("derives fixed-distance splits from distance and time streams", () => {
    const times = Array.from({ length: 101 }, (_, index) => index);
    const splits = distanceSplits(
      {
        time: stream(times),
        distance: stream(times.map((index) => index * 100)),
        moving: stream(times.map(() => true)),
        watts: stream(times.map(() => 200)),
        heartrate: stream(times.map(() => 140)),
        altitude: stream(times.map((index) => index)),
      },
      5000
    );
    expect(splits).toHaveLength(2);
    expect(splits[0]).toEqual({
      index: 1,
      distanceM: 5000,
      timeSec: 50,
      averageSpeedKmh: 360,
      averageWatts: 200,
      averageHeartrate: 140,
      elevationGainM: 50,
    });
  });

  it("uses route location and shape for deterministic same-route identity", () => {
    const route = "_p~iF~ps|U_ulLnnqC_mqNvxq`@";
    expect(routeFingerprint(route)).toBe(routeFingerprint(route));
    expect(routeFingerprint(route)).not.toBeNull();
    expect(routeFingerprint("")).toBeNull();
  });
});
