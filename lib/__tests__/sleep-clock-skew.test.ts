import { describe, it, expect } from "vitest";
import {
  detectSleepClockSkew,
  MIN_MEDIAN_BPM_GAP,
  type HrMinuteSample,
} from "@/lib/sleep-clock-skew";

// The PURE discriminator for issue #4299. The whole point of this module is that it
// keys on the HR contradiction and on nothing else, so these fixtures differ ONLY in
// where the heart-rate trough sits — the clocks, the durations and the schedule break
// are identical between the night that must flag and the night that must not.

const ASLEEP = 58;
const AWAKE = 74;
const MIN = 60_000;

// A per-minute trace over [from, to), asleep inside `trough` and awake outside it.
// `everyNthMinute` thins the trace: 1 is a complete minute-by-minute record, 3 leaves
// coverage at a third, which is how the no-concurrent-coverage case is built.
function trace(
  from: string,
  to: string,
  trough: { from: string; to: string } | null,
  everyNthMinute = 1
): HrMinuteSample[] {
  const start = Date.parse(from);
  const end = Date.parse(to);
  const lo = trough ? Date.parse(trough.from) : 0;
  const hi = trough ? Date.parse(trough.to) : 0;
  const out: HrMinuteSample[] = [];
  for (let i = 0; start + i * MIN < end; i++) {
    if (i % everyNthMinute !== 0) continue;
    const at = start + i * MIN;
    out.push({
      ts: new Date(at).toISOString().slice(0, 19) + "Z",
      bpm: trough && at >= lo && at < hi ? ASLEEP : AWAKE,
    });
  }
  return out;
}

// The sighting, in UTC. The exporter stamped the night +6h, so the stored session
// claims 09:39→14:37 while the body's overnight trough sits at 03:39→08:37.
const SKEWED_SESSION = {
  start: "2026-08-30T09:39:00Z",
  end: "2026-08-30T14:37:00Z",
};
const DAY_FROM = "2026-08-29T22:00:00Z";
const DAY_TO = "2026-08-30T22:00:00Z";

describe("detectSleepClockSkew", () => {
  it("flags the skewed night and names the trough it disagrees with", () => {
    const found = detectSleepClockSkew(
      SKEWED_SESSION,
      trace(DAY_FROM, DAY_TO, {
        from: "2026-08-30T03:39:00Z",
        to: "2026-08-30T08:37:00Z",
      })
    );
    expect(found).not.toBeNull();
    expect(found).toMatchObject({
      start: SKEWED_SESSION.start,
      end: SKEWED_SESSION.end,
      claimedBpm: AWAKE,
      troughBpm: ASLEEP,
    });
    // The evidence points at the real night, not at some arbitrary quiet quarter-hour:
    // a session-width window inside the true trough, hours before the claim.
    const troughAt = Date.parse(found!.troughStart);
    expect(troughAt).toBeGreaterThanOrEqual(Date.parse("2026-08-30T03:39:00Z"));
    expect(troughAt).toBeLessThan(Date.parse("2026-08-30T08:37:00Z"));
    // It states a measurement, never an inferred offset (#4299 out of scope).
    expect(Object.keys(found!)).not.toContain("offsetHours");
  });

  // Every row below must return null. They are the false-alarm cases the detector
  // exists to stay quiet on, plus the malformed inputs it must not throw over.
  it.each([
    [
      // TRUE JET LAG (the owner's Hawaii week). Same clocks, same duration, same
      // schedule break as the flagged night — the session IS the trough, so nothing
      // in the surrounding day contradicts it.
      //
      // This row is silent for a STRONGER reason than the bpm threshold, and that is
      // worth knowing: lowering MIN_MEDIAN_BPM_GAP to 0 leaves it green, because no
      // comparable window is LOWER than the claim at all. What it does catch is the
      // signed comparison — swapping the gap for Math.abs() reds exactly this row,
      // which is the "the session disagrees with some window" bug that would turn
      // every real jet-lag night into a false alarm.
      "a genuinely shifted night whose HR agrees with its clocks",
      SKEWED_SESSION,
      trace(DAY_FROM, DAY_TO, {
        from: SKEWED_SESSION.start,
        to: SKEWED_SESSION.end,
      }),
    ],
    [
      // The trace exists but covers under half the claimed window.
      "a session with no concurrent HR coverage",
      SKEWED_SESSION,
      trace(
        DAY_FROM,
        DAY_TO,
        { from: "2026-08-30T03:39:00Z", to: "2026-08-30T08:37:00Z" },
        3
      ),
    ],
    ["a session with no HR at all", SKEWED_SESSION, []],
    [
      // A gap of MIN_MEDIAN_BPM_GAP - 1 is ordinary night-to-night variation as far as
      // this module is concerned, and it says nothing.
      "a trough that is lower but not materially so",
      SKEWED_SESSION,
      trace(DAY_FROM, DAY_TO, null).map((s) =>
        s.ts >= "2026-08-30T03:39:00Z" && s.ts < "2026-08-30T08:37:00Z"
          ? { ...s, bpm: AWAKE - (MIN_MEDIAN_BPM_GAP - 1) }
          : s
      ),
    ],
    [
      "a zero-width session",
      { start: SKEWED_SESSION.start, end: SKEWED_SESSION.start },
      trace(DAY_FROM, DAY_TO, {
        from: "2026-08-30T03:39:00Z",
        to: "2026-08-30T08:37:00Z",
      }),
    ],
    [
      "an unparseable session window",
      { start: "not-a-time", end: "also-not" },
      trace(DAY_FROM, DAY_TO, {
        from: "2026-08-30T03:39:00Z",
        to: "2026-08-30T08:37:00Z",
      }),
    ],
  ])("stays silent on %s", (_case, session, hr) => {
    expect(detectSleepClockSkew(session, hr)).toBeNull();
  });

  it("ignores a trough further from the claim than the surrounding day", () => {
    // A quiet window 20 hours away is not evidence about THIS night. The claim's own
    // day is awake-level throughout, so nothing inside the search radius contradicts it.
    const far = trace("2026-08-29T00:00:00Z", "2026-08-31T00:00:00Z", {
      from: "2026-08-29T10:00:00Z",
      to: "2026-08-29T15:00:00Z",
    });
    expect(detectSleepClockSkew(SKEWED_SESSION, far)).toBeNull();
  });
});
