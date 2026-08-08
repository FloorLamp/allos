// PURE TIER — the quiet-stream predicate (#2146) and the continuous-stream
// declarations it reads.
//
// The cases below are the ones that keep the predicate honest, and they are chosen
// against the MEASURED distribution the issue carries: 56 days of one real profile's
// `hr_minutes`, in which routine removals cluster at 1–2.5 h (16 of them, average
// 95 min) and real events sit above 2.5 h (5 of them, about one per 11 days), with an
// empty valley between at 2.1–2.5 h.
//
// The two that matter most are the NON-firings:
//
//   • a dip inside tolerance — the evening charge, the shower, the workout removal.
//     Fire on those and the signal is noise within a week.
//   • a gap window with NO ok syncs — the phone is off, not the watch. That is the
//     #1685 staleness detector's case, it already names it, and two rows for one
//     outage is exactly what constraint 1 exists to prevent.

import { describe, it, expect } from "vitest";
import {
  quietStreamDedupeKey,
  quietStreamDetail,
  quietStreamTitle,
  quietStreamVerdict,
  quietStreams,
  type QuietStreamCandidate,
  type QuietStreamSignals,
} from "@/lib/integrations/quiet-stream";
import {
  allContinuousStreams,
  continuousStream,
  continuousStreamsFor,
  quietReportableStreams,
  streamsWithReminder,
} from "@/lib/integrations/continuous-streams";
import { INTEGRATIONS, getIntegration } from "@/lib/integrations/registry";
import { isStreamActive } from "@/lib/stream-activity";
import {
  buildAttentionModel,
  isEscalatingIntegration,
  type AttentionIntegration,
} from "@/lib/attention";

const HOUR = 60;
// The declared Health Connect heart-rate tolerance: 2.5 h, the measured valley.
const TOLERANCE = 150;

/** The measured off-wrist signature, with one field at a time overridden. */
function offWrist(over: Partial<QuietStreamSignals> = {}): QuietStreamSignals {
  return {
    provider: "health-connect",
    streamId: "heart-rate",
    providerHealthy: true,
    expectedActive: true,
    // 21:05 → 06:24, the worst of the five measured events: the watch spent the night
    // on the charger and the profile lost its only sleep night in eight weeks.
    minutesSinceStream: 9 * HOUR + 19,
    syncedDuringGap: true,
    toleranceMin: TOLERANCE,
    ...over,
  };
}

describe("quietStreamVerdict (#2146)", () => {
  it("fires on the measured off-wrist signature", () => {
    expect(quietStreamVerdict(offWrist())).toEqual({
      quiet: true,
      quietForMin: 9 * HOUR + 19,
    });
  });

  it("does NOT fire on a dip inside the declared tolerance", () => {
    // The measured routine-removal cluster: 1–2.5 h, average 95 min, ten of them
    // starting 19:00–21:00 local (evening charging) and six at workout hours.
    for (const minutes of [61, 95, 120, TOLERANCE - 1]) {
      expect(
        quietStreamVerdict(offWrist({ minutesSinceStream: minutes }))
      ).toEqual({
        quiet: false,
        skip: "stream-live",
      });
    }
  });

  it("treats a stream sitting EXACTLY at its tolerance as still live", () => {
    // The house freshness doctrine: stale strictly AFTER the interval. One minute
    // past it is the first quiet minute.
    expect(
      quietStreamVerdict(offWrist({ minutesSinceStream: TOLERANCE }))
    ).toEqual({ quiet: false, skip: "stream-live" });
    expect(
      quietStreamVerdict(offWrist({ minutesSinceStream: TOLERANCE + 1 }))
    ).toMatchObject({ quiet: true });
  });

  it("does NOT fire on a connection outage — no ok syncs in the window (constraint 1)", () => {
    // The load-bearing clause. Same silence, but nothing synced during it: the PHONE
    // is off, not the watch. #1685's staleness detector owns this and already names
    // it, so reporting it here would be two rows and two voices for one fault.
    expect(quietStreamVerdict(offWrist({ syncedDuringGap: false }))).toEqual({
      quiet: false,
      skip: "no-ok-sync",
    });
  });

  it("does NOT fire on a backfilled gap — the stream's newest row moved forward", () => {
    // Backfill heals retroactively with no marker to clear: the predicate is a
    // function of max(ts), and a backfilled batch moves max(ts) to the present.
    expect(quietStreamVerdict(offWrist({ minutesSinceStream: 3 }))).toEqual({
      quiet: false,
      skip: "stream-live",
    });
  });

  it("does NOT fire for a provider already carrying a failing/stale row (constraint 7)", () => {
    // Checked FIRST, before anything about the data: one row names the cause.
    expect(quietStreamVerdict(offWrist({ providerHealthy: false }))).toEqual({
      quiet: false,
      skip: "provider-unhealthy",
    });
    // And it wins even when every other signal screams.
    expect(
      quietStreamVerdict(
        offWrist({ providerHealthy: false, minutesSinceStream: 40 * HOUR })
      )
    ).toEqual({ quiet: false, skip: "provider-unhealthy" });
  });

  it("does NOT fire for a stream that was not delivering to begin with", () => {
    // The shared #2097/#2146 expected-active gate. A watch put away three weeks ago
    // is not "quiet" — nothing was interrupted — and without this the row would
    // render every single day forever, because the phone keeps syncing.
    expect(quietStreamVerdict(offWrist({ expectedActive: false }))).toEqual({
      quiet: false,
      skip: "not-expected-active",
    });
  });

  it("does NOT fire when the stream has never delivered anything", () => {
    expect(quietStreamVerdict(offWrist({ minutesSinceStream: null }))).toEqual({
      quiet: false,
      skip: "no-stream",
    });
  });
});

describe("quietStreams — one row per provider", () => {
  function candidate(
    over: Partial<QuietStreamCandidate> = {}
  ): QuietStreamCandidate {
    return {
      ...offWrist(),
      sinceAt: "2026-07-14T21:05:00Z",
      sinceLocalHhmm: "21:05",
      today: "2026-07-15",
      ...over,
    };
  }

  it("collapses several quiet streams of one provider to the longest-quiet one", () => {
    // "Your watch is off" is ONE fact however many streams it interrupts, and the
    // longest-quiet one names the earliest honest 'since'.
    const rows = quietStreams([
      candidate({ minutesSinceStream: 200 }),
      candidate({ minutesSinceStream: 560, sinceLocalHhmm: "21:05" }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].quietForMin).toBe(560);
  });

  it("drops every candidate that does not fire", () => {
    expect(
      quietStreams([
        candidate({ syncedDuringGap: false }),
        candidate({ minutesSinceStream: 30 }),
        candidate({ providerHealthy: false }),
      ])
    ).toEqual([]);
  });
});

describe("the reach boundary — quiet-stream never escalates (constraint 4)", () => {
  const quiet: AttentionIntegration = {
    id: "health-connect",
    provider: "Google Health Connect",
    detail: "No heart-rate data has arrived since 9:05 PM.",
    kind: "quiet-stream",
  };
  const stale: AttentionIntegration = {
    id: "strava",
    provider: "Strava",
    detail: "No data since 2026-07-10.",
    kind: "stale",
  };

  it("classifies the kinds", () => {
    expect(isEscalatingIntegration(quiet)).toBe(false);
    expect(isEscalatingIntegration(stale)).toBe(true);
    expect(isEscalatingIntegration({ ...stale, kind: "failing" })).toBe(true);
    // An undeclared kind is the legacy `failing` shape and still escalates.
    expect(isEscalatingIntegration({ ...stale, kind: undefined })).toBe(true);
  });

  it("keeps a quiet-stream row OUT of the shared attention model", () => {
    // The hero, the Upcoming page and — through the same builder — the morning
    // digest all read this model. A coaching-tier observation may not travel a send,
    // so the filter is in the builder rather than only in the wiring.
    const items = buildAttentionModel({
      upcoming: [],
      flaggedBiomarkers: [],
      integrations: [quiet, stale],
      reviewCount: 0,
      today: "2026-07-15",
    });
    const integrationItems = items.filter((i) => i.domain === "integration");
    expect(integrationItems.map((i) => i.key)).toEqual(["integration:strava"]);
  });
});

describe("the copy", () => {
  it("states the observation, then asks — it never instructs", () => {
    const detail = quietStreamDetail({
      streamLabel: "heart-rate",
      sinceClock: "10:10 AM",
      quietForMin: 4 * HOUR,
      prompt: "Is the watch on your wrist and charged?",
    });
    expect(detail).toBe(
      "No heart-rate data has arrived since 10:10 AM — 4 hours ago. " +
        "Is the watch on your wrist and charged?"
    );
    // An observation domain carries no obligation, so no imperative may appear.
    expect(detail).not.toMatch(/put (it|your watch) on/i);
  });

  it("names the surprise in the title: it IS syncing", () => {
    expect(quietStreamTitle("Google Health Connect", "heart-rate")).toBe(
      "Google Health Connect is syncing, but heart-rate data has stopped"
    );
  });

  it("scopes the dedupe key to the profile-local DAY", () => {
    const key = quietStreamDedupeKey({
      provider: "health-connect",
      streamId: "heart-rate",
      today: "2026-07-15",
    });
    expect(key).toBe("quiet-stream:health-connect:heart-rate:2026-07-15");
    // Silencing this morning must not silence next Tuesday's.
    expect(key).not.toBe(
      quietStreamDedupeKey({
        provider: "health-connect",
        streamId: "heart-rate",
        today: "2026-07-16",
      })
    );
  });
});

describe("the registry declaration", () => {
  it("declares Health Connect's heart-rate stream with its measured tolerance", () => {
    const hc = continuousStream("health-connect", "heart-rate");
    expect(hc?.stream.table).toBe("hr_minutes");
    expect(hc?.stream.rowsPerHour).toBe(60);
    expect(hc?.stream.quiet?.dipToleranceMin).toBe(TOLERANCE);
    // The evidence rides the declaration, so the number cannot be moved silently.
    expect(hc?.stream.quiet?.because).toMatch(/bimodal/i);
  });

  it("exempts a provider with no continuous streams BY CONSTRUCTION (constraint 3)", () => {
    // No exemption list anywhere in lib/: a provider with nothing continuous to
    // deliver simply declares nothing, and the detector never sees it. This is the
    // ledger that forces a NEW provider to make the decision explicitly rather than
    // inherit an accidental default — it is a test-side ledger, not a runtime list.
    const withStreams = INTEGRATIONS.filter(
      (i) => continuousStreamsFor(i).length > 0
    ).map((i) => i.id);
    expect(withStreams).toEqual(["health-connect"]);

    for (const id of [
      // Outbound: nothing ever arrives.
      "calendar-feed",
      // Attended, run by hand on the user's own machine.
      "patient-portals",
      // A file the user hands us; no live cadence to be silent against, even though
      // it is the app's other hr_minutes writer.
      "fitbit-takeout",
      // Pulled by allos, but its data is hourly forecast, not a continuous stream —
      // proof the two axes are distinct.
      "weather",
      "garmin",
      "strava",
      "oura",
      "withings",
    ] as const) {
      expect(continuousStreamsFor(getIntegration(id))).toEqual([]);
    }
  });

  it("enumerates streams with their provider — the #2162 seam", () => {
    const all = allContinuousStreams();
    expect(all.map((s) => `${s.provider}:${s.stream.id}`)).toEqual([
      "health-connect:heart-rate",
    ]);
    // The facets are independently optional, so a lifecycle feature can ask which
    // streams carry a reminder adapter without this shape widening first.
    expect(streamsWithReminder("bedtime-wear").map((s) => s.provider)).toEqual([
      "health-connect",
    ]);
    expect(quietReportableStreams().map((s) => s.stream.id)).toEqual([
      "heart-rate",
    ]);
  });

  it("gives every declared stream a positive tolerance and an activity window", () => {
    for (const { stream } of allContinuousStreams()) {
      expect(stream.rowsPerHour).toBeGreaterThan(0);
      expect(stream.expectedActive.windowDays).toBeGreaterThan(0);
      expect(stream.expectedActive.minDays).toBeGreaterThan(0);
      expect(stream.expectedActive.minDays).toBeLessThanOrEqual(
        stream.expectedActive.windowDays
      );
      if (stream.quiet) {
        expect(stream.quiet.dipToleranceMin).toBeGreaterThan(0);
        expect(stream.quiet.because.length).toBeGreaterThan(40);
        expect(stream.quiet.prompt.length).toBeGreaterThan(10);
      }
    }
  });
});

describe("isStreamActive — the shared #2097/#2146 declaration shape", () => {
  const TODAY = "2026-07-15";

  it("counts the days BEHIND today, never today itself", () => {
    // Today having nothing is precisely the case both callers exist for, so it must
    // not be able to change the answer.
    expect(isStreamActive(["2026-07-14", "2026-07-13"], TODAY, 3, 2)).toBe(
      true
    );
    expect(isStreamActive(["2026-07-15", "2026-07-15"], TODAY, 3, 2)).toBe(
      false
    );
  });

  it("tolerates one forgotten charge and gives up after two misses", () => {
    expect(isStreamActive(["2026-07-14", "2026-07-12"], TODAY, 3, 2)).toBe(
      true
    );
    expect(isStreamActive(["2026-07-12"], TODAY, 3, 2)).toBe(false);
  });

  it("takes the window from the DECLARATION, not from a fitted pattern", () => {
    const days = ["2026-07-10", "2026-07-09"];
    expect(isStreamActive(days, TODAY, 3, 2)).toBe(false);
    expect(isStreamActive(days, TODAY, 7, 2)).toBe(true);
  });
});
