import { describe, it, expect } from "vitest";
import {
  computeSleepRegularity,
  sriTrend,
  regularityTravelInsight,
  type SleepSession,
} from "../sleep-regularity";

// Build a UTC overnight session: bed `bedHhmm` the evening BEFORE `wakeDay`,
// waking at `wakeHhmm` on `wakeDay`. Times are UTC ("Z"), so with tz "UTC" the
// wall clock equals the stored instant — the simplest hand-checkable case.
function utcNight(
  wakeDay: string,
  bedHhmm = "23:00",
  wakeHhmm = "07:00"
): SleepSession {
  const prev = new Date(wakeDay + "T00:00:00Z");
  prev.setUTCDate(prev.getUTCDate() - 1);
  const prevDay = prev.toISOString().slice(0, 10);
  return {
    start: `${prevDay}T${bedHhmm}:00Z`,
    end: `${wakeDay}T${wakeHhmm}:00Z`,
  };
}

function consecutiveWakeDays(start: string, n: number): string[] {
  const out: string[] = [];
  const d = new Date(start + "T00:00:00Z");
  for (let i = 0; i < n; i++) {
    out.push(d.toISOString().slice(0, 10));
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}

describe("computeSleepRegularity — SRI formula", () => {
  it("a perfectly reproducible schedule scores SRI = 100", () => {
    // 16 identical nights (bed 23:00, wake 07:00) — passes the default 14-night
    // gate. Every consecutive-day pair matches at every epoch, so SRI = 100.
    const sessions = consecutiveWakeDays("2026-01-02", 16).map((d) =>
      utcNight(d)
    );
    const r = computeSleepRegularity(sessions, "UTC");
    expect(r).not.toBeNull();
    expect(r!.sri).toBe(100);
    expect(r!.nights).toBe(16);
    expect(r!.pairs).toBe(15);
    expect(r!.bedtimeSdMin).toBe(0);
    expect(r!.waketimeSdMin).toBe(0);
    // All nights share one mid-sleep, so weekend and weekday means are equal.
    expect(r!.socialJetlagMin).toBe(0);
  });

  it("matches a HAND-COMPUTED value for a shifted night (≈83.3)", () => {
    // Night A (wake 01-02): asleep 23:00→07:00.
    // Night B (wake 01-03): asleep 00:00→08:00 (a 2-hour-later, 1-hour-longer bed).
    // Hand tally of the 1440 clock-minute epochs between the two noon-anchored
    // sleep-days:
    //   • 12:00–22:59  both awake            → 660 match
    //   • 23:00–23:59  A asleep, B awake     →  60 MISMATCH
    //   • 00:00–06:59  both asleep           → 420 match
    //   • 07:00–07:59  A awake,  B asleep     →  60 MISMATCH
    //   • 08:00–11:59  both awake            → 240 match
    // matches = 1320 of 1440 → SRI = -100 + 200·(1320/1440) = 83.333…
    const sessions: SleepSession[] = [
      { start: "2026-01-01T23:00:00Z", end: "2026-01-02T07:00:00Z" },
      { start: "2026-01-03T00:00:00Z", end: "2026-01-03T08:00:00Z" },
    ];
    const r = computeSleepRegularity(sessions, "UTC", { minNights: 2 });
    expect(r).not.toBeNull();
    expect(r!.pairs).toBe(1);
    expect(r!.sri).toBe(83.3);
  });

  it("returns null below the minimum-nights gate", () => {
    const sessions = consecutiveWakeDays("2026-01-02", 13).map((d) =>
      utcNight(d)
    );
    // 13 < default 14 → not enough data.
    expect(computeSleepRegularity(sessions, "UTC")).toBeNull();
    // Same data clears a lower gate.
    expect(
      computeSleepRegularity(sessions, "UTC", { minNights: 10 })
    ).not.toBeNull();
  });
});

describe("computeSleepRegularity — missing nights", () => {
  it("a gap breaks the consecutive-day pair (absence is NOT treated as wake)", () => {
    // Nights on 01-02, 01-03, then a GAP (01-04 missing), then 01-05.
    // Only (01-02,01-03) is an adjacent observed pair; (01-03,01-05) is skipped.
    const sessions = ["2026-01-02", "2026-01-03", "2026-01-05"].map((d) =>
      utcNight(d)
    );
    const r = computeSleepRegularity(sessions, "UTC", { minNights: 3 });
    expect(r).not.toBeNull();
    expect(r!.nights).toBe(3);
    expect(r!.pairs).toBe(1); // the gap contributes no pair
    expect(r!.sri).toBe(100); // the one adjacent pair is identical
  });
});

describe("computeSleepRegularity — timezone correctness", () => {
  it("uses the PROFILE timezone across a DST spring-forward (server is UTC)", () => {
    // America/New_York springs forward 2026-03-08 02:00→03:00. Four nights, each
    // bed 23:00 / wake 07:00 in NEW YORK local time — perfectly regular in clock
    // time even though the 03-07→03-08 night is only 23h of absolute duration.
    // Instants are UTC: EST = −5 before the change, EDT = −4 after.
    const sessions: SleepSession[] = [
      { start: "2026-03-06T04:00:00Z", end: "2026-03-06T12:00:00Z" }, // wake 03-06
      { start: "2026-03-07T04:00:00Z", end: "2026-03-07T12:00:00Z" }, // wake 03-07
      { start: "2026-03-08T04:00:00Z", end: "2026-03-08T11:00:00Z" }, // wake 03-08 (DST)
      { start: "2026-03-09T03:00:00Z", end: "2026-03-09T11:00:00Z" }, // wake 03-09
    ];
    const r = computeSleepRegularity(sessions, "America/New_York", {
      minNights: 3,
    });
    expect(r).not.toBeNull();
    // Regular in NY clock time → SRI 100 and zero timing spread. A naive
    // absolute-UTC bucketing would see the 03:00Z bedtime as an outlier and score < 100.
    expect(r!.sri).toBe(100);
    expect(r!.bedtimeSdMin).toBe(0);
    expect(r!.waketimeSdMin).toBe(0);
  });

  it("attributes wake-days by the profile timezone, not the server timezone", () => {
    // Sessions whose UTC end-date and America/Los_Angeles (−8) local date differ:
    // each ends 06:00Z (22:00 the PREVIOUS LA day). So the same instants map to
    // wake-days one calendar day earlier under LA than under UTC.
    const sessions: SleepSession[] = [
      { start: "2026-01-02T02:00:00Z", end: "2026-01-02T06:00:00Z" },
      { start: "2026-01-03T02:00:00Z", end: "2026-01-03T06:00:00Z" },
      { start: "2026-01-04T02:00:00Z", end: "2026-01-04T06:00:00Z" },
    ];
    const la = computeSleepRegularity(sessions, "America/Los_Angeles", {
      minNights: 3,
    });
    const utc = computeSleepRegularity(sessions, "UTC", { minNights: 3 });
    expect(la).not.toBeNull();
    expect(utc).not.toBeNull();
    // LA sees wake-days 01-01..01-03; UTC sees 01-02..01-04.
    expect(la!.windowEnd).toBe("2026-01-03");
    expect(utc!.windowEnd).toBe("2026-01-04");
  });
});

describe("computeSleepRegularity — companions", () => {
  it("computes social jetlag as the weekend-vs-weekday mid-sleep shift", () => {
    // 2026-01-01 is a Thursday, so 01-03/01-04 and 01-10/01-11 are Sat/Sun.
    // Weekday nights: bed 23:00, wake 07:00 → mid-sleep 03:00.
    // Weekend nights: bed 01:00, wake 09:00 → mid-sleep 05:00 (2h later).
    const wakeDays = consecutiveWakeDays("2026-01-02", 14);
    const sessions = wakeDays.map((d) => {
      const dow = new Date(d + "T00:00:00Z").getUTCDay();
      const weekend = dow === 0 || dow === 6;
      return weekend
        ? { start: `${d}T01:00:00Z`, end: `${d}T09:00:00Z` } // 01:00→09:00 same day
        : utcNight(d, "23:00", "07:00");
    });
    const r = computeSleepRegularity(sessions, "UTC");
    expect(r).not.toBeNull();
    expect(r!.socialJetlagMin).toBe(120);
  });

  it("reports null social jetlag when a window has no weekend nights", () => {
    // Five weekday nights (wake Mon–Fri, 01-05..01-09), no Sat/Sun.
    const sessions = [
      "2026-01-05",
      "2026-01-06",
      "2026-01-07",
      "2026-01-08",
      "2026-01-09",
    ].map((d) => utcNight(d));
    const r = computeSleepRegularity(sessions, "UTC", { minNights: 3 });
    expect(r).not.toBeNull();
    expect(r!.socialJetlagMin).toBeNull();
  });
});

describe("sriTrend", () => {
  it("emits a rolling point per gated wake-day, oldest→newest", () => {
    const sessions = consecutiveWakeDays("2026-01-02", 20).map((d) =>
      utcNight(d)
    );
    const trend = sriTrend(sessions, "UTC", { windowDays: 28, minNights: 14 });
    // First 13 wake-days can't yet see 14 nights; points start once the gate clears.
    expect(trend.length).toBe(20 - 14 + 1);
    expect(trend[0].sri).toBe(100);
    expect(trend[trend.length - 1].date).toBe("2026-01-21");
    // Ascending by date.
    const dates = trend.map((p) => p.date);
    expect([...dates].sort()).toEqual(dates);
  });
});

describe("regularityTravelInsight", () => {
  const beforeTravel = [
    { date: "2026-06-01", sri: 90 },
    { date: "2026-06-02", sri: 88 },
    { date: "2026-06-03", sri: 91 },
    { date: "2026-06-04", sri: 89 },
    { date: "2026-06-05", sri: 92 },
  ];
  const afterTravel = [
    { date: "2026-06-11", sri: 70 },
    { date: "2026-06-12", sri: 68 },
    { date: "2026-06-13", sri: 71 },
    { date: "2026-06-14", sri: 69 },
    { date: "2026-06-15", sri: 72 },
  ];

  it("flags a clean regularity drop across a travel-start boundary", () => {
    const note = regularityTravelInsight(
      [...beforeTravel, ...afterTravel],
      [{ date: "2026-06-10", situation: "Travel", change: "start" }]
    );
    expect(note).toContain("Sleep regularity dropped");
    expect(note).toContain("2026-06-10");
  });

  it("returns null without a travel situation", () => {
    expect(
      regularityTravelInsight([...beforeTravel, ...afterTravel], [])
    ).toBeNull();
  });

  it("returns null when the drop is too small to be worth surfacing", () => {
    const flat = beforeTravel.concat(
      afterTravel.map((p) => ({ ...p, sri: p.sri + 18 }))
    );
    expect(
      regularityTravelInsight(flat, [
        { date: "2026-06-10", situation: "Travel", change: "start" },
      ])
    ).toBeNull();
  });
});
