import { describe, it, expect } from "vitest";
import {
  AWAKE_RUN_MINUTES,
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

// A per-minute trace over [from, to). Each minute takes the bpm of the first segment
// that contains it, or AWAKE when none does. `everyNthMinute` thins the trace: 1 is a
// complete minute-by-minute record, 3 leaves coverage at a third, which is how the
// no-concurrent-coverage case is built.
interface Segment {
  from: string;
  to: string;
  bpm: number;
}

function segmentTrace(
  from: string,
  to: string,
  segments: Segment[],
  everyNthMinute = 1
): HrMinuteSample[] {
  const start = Date.parse(from);
  const end = Date.parse(to);
  const bounds = segments.map((s) => ({
    lo: Date.parse(s.from),
    hi: Date.parse(s.to),
    bpm: s.bpm,
  }));
  const out: HrMinuteSample[] = [];
  for (let i = 0; start + i * MIN < end; i++) {
    if (i % everyNthMinute !== 0) continue;
    const at = start + i * MIN;
    const hit = bounds.find((b) => at >= b.lo && at < b.hi);
    out.push({
      ts: new Date(at).toISOString().slice(0, 19) + "Z",
      bpm: hit ? hit.bpm : AWAKE,
    });
  }
  return out;
}

// The common shape: one trough, awake either side of it.
function trace(
  from: string,
  to: string,
  trough: { from: string; to: string } | null,
  everyNthMinute = 1
): HrMinuteSample[] {
  return segmentTrace(
    from,
    to,
    trough ? [{ ...trough, bpm: ASLEEP }] : [],
    everyNthMinute
  );
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

// The SECOND reading (#5020). A shift shorter than the night is long leaves the real
// trough overlapping the claim, so the median reading above has no comparable window
// left to stand the claim against. These fixtures differ only in what the claimed
// window HOLDS: the clocks and the durations are ordinary in every one of them.
describe("detectSleepClockSkew, the awake-level run", () => {
  // The 08-27 night on prod: stamped three hours late, so the first two-thirds of the
  // claim really is the trough and the last three hours are the afternoon.
  const LATE_SESSION = {
    start: "2026-08-27T09:53:00Z",
    end: "2026-08-27T16:31:00Z",
  };
  const LATE_DAY_FROM = "2026-08-26T18:00:00Z";
  const LATE_DAY_TO = "2026-08-27T22:00:00Z";
  const lateTrace = (everyNthMinute = 1): HrMinuteSample[] =>
    segmentTrace(
      LATE_DAY_FROM,
      LATE_DAY_TO,
      [
        {
          from: "2026-08-27T07:00:00Z",
          to: "2026-08-27T13:30:00Z",
          bpm: ASLEEP,
        },
      ],
      everyNthMinute
    );

  it("flags a shift shorter than the session, which the median reading cannot see", () => {
    const found = detectSleepClockSkew(LATE_SESSION, lateTrace());
    expect(found).not.toBeNull();
    // The median reading really is blind here: the bulk of the claim IS the trough, so
    // its median sits BELOW every comparable window in the day. Only the run speaks.
    expect(found!.claimedBpm).toBe(ASLEEP);
    expect(found!.claimedBpm - found!.troughBpm).toBeLessThan(
      MIN_MEDIAN_BPM_GAP
    );
    expect(found!.awakeRun).not.toBeNull();
    expect(found!.awakeRun!.bpm).toBe(AWAKE);
    // The run it names is the afternoon inside the claim, not the night before it.
    // Runs are found on the quarter-hour grid, so the first block can straddle the
    // moment the body woke and the start can sit up to one block before it.
    const runAt = Date.parse(found!.awakeRun!.start);
    expect(runAt).toBeGreaterThanOrEqual(
      Date.parse("2026-08-27T13:30:00Z") - 15 * MIN
    );
    expect(runAt + AWAKE_RUN_MINUTES * MIN).toBeLessThanOrEqual(
      Date.parse(LATE_SESSION.end)
    );
  });

  it("names no run on a night the median reading catches on its own", () => {
    // The already-shipped case. Its copy quotes an equally long window holding the
    // overnight low, and that window exists, so the finding must not switch sentences.
    const found = detectSleepClockSkew(
      SKEWED_SESSION,
      trace(DAY_FROM, DAY_TO, {
        from: "2026-08-30T03:39:00Z",
        to: "2026-08-30T08:37:00Z",
      })
    );
    expect(found!.awakeRun).toBeNull();
  });

  it.each([
    [
      // THE DISCRIMINATING NEGATIVE. A real night that ends with the person awake in
      // bed. The tail is real awake-level heart rate inside the claimed window — it is
      // just far short of a run, which is the whole reason the length is a declared
      // number and not a judgement call.
      "a real night with a 30-minute awake tail",
      { start: "2026-08-27T02:00:00Z", end: "2026-08-27T08:00:00Z" },
      segmentTrace(LATE_DAY_FROM, LATE_DAY_TO, [
        {
          from: "2026-08-27T02:00:00Z",
          to: "2026-08-27T07:30:00Z",
          bpm: ASLEEP,
        },
      ]),
    ],
    [
      // One quarter-hour short of the bound. The run length is load-bearing: widen the
      // awake block to AWAKE_RUN_MINUTES and this same shape flags.
      "an awake block a quarter-hour short of the bound",
      { start: "2026-08-27T02:00:00Z", end: "2026-08-27T10:00:00Z" },
      segmentTrace(LATE_DAY_FROM, LATE_DAY_TO, [
        {
          from: "2026-08-27T05:00:00Z",
          to: "2026-08-27T06:45:00Z",
          bpm: AWAKE,
        },
        {
          from: "2026-08-27T02:00:00Z",
          to: "2026-08-27T10:00:00Z",
          bpm: ASLEEP,
        },
      ]),
    ],
    [
      // The AWAKE ANCHOR is load-bearing. This person's day runs at 90, so a two-hour
      // stretch at 70 inside the night is elevated against the night — 12 bpm above its
      // median, clear of MIN_MEDIAN_BPM_GAP — and still nowhere near their daytime. An
      // ordinary night's own variation must never be enough on its own.
      "a raised stretch that never reaches the person's own daytime level",
      { start: "2026-08-27T02:00:00Z", end: "2026-08-27T10:00:00Z" },
      segmentTrace(
        LATE_DAY_FROM,
        LATE_DAY_TO,
        [
          { from: "2026-08-27T05:00:00Z", to: "2026-08-27T07:00:00Z", bpm: 70 },
          {
            from: "2026-08-27T02:00:00Z",
            to: "2026-08-27T10:00:00Z",
            bpm: ASLEEP,
          },
        ],
        1
      ).map((s) =>
        s.ts < "2026-08-27T02:00:00Z" || s.ts >= "2026-08-27T10:00:00Z"
          ? { ...s, bpm: 90 }
          : s
      ),
    ],
    [
      // Coverage gates the second reading exactly as it gates the first: a trace this
      // thin can never flag, however the claimed hours look.
      "the same late night with no concurrent HR coverage",
      LATE_SESSION,
      lateTrace(3),
    ],
    [
      // The claim carries coverage overall and the stretch that WOULD be the run does
      // not. A run is gated block by block, so a run cannot become a way around the
      // coverage rule the first reading already obeys.
      "a claim covered overall but sparse exactly where the run would be",
      LATE_SESSION,
      lateTrace().filter(
        (s, i) => s.ts < "2026-08-27T13:30:00Z" || i % 3 === 0
      ),
    ],
  ])("stays silent on %s", (_case, session, hr) => {
    expect(detectSleepClockSkew(session, hr)).toBeNull();
  });

  it("also flags a real night stamped across a full two-hour arousal", () => {
    // The declared reach, recorded rather than hidden. FRAGMENT_MERGE_GAP_MAX_MIN is
    // the repo's bound on the longest awake gap still inside ONE night, so a source
    // that stamps a single session across a longer one is contradicted by the repo's
    // own number. `mainSleepPeriod` would already have called this two nights.
    const found = detectSleepClockSkew(
      { start: "2026-08-27T02:00:00Z", end: "2026-08-27T10:00:00Z" },
      segmentTrace(LATE_DAY_FROM, LATE_DAY_TO, [
        {
          from: "2026-08-27T05:00:00Z",
          to: "2026-08-27T07:00:00Z",
          bpm: AWAKE,
        },
        {
          from: "2026-08-27T02:00:00Z",
          to: "2026-08-27T10:00:00Z",
          bpm: ASLEEP,
        },
      ])
    );
    expect(found).not.toBeNull();
    expect(found!.awakeRun!.start).toBe("2026-08-27T05:00:00Z");
  });
});

// ── What the copy may name (#5021) ───────────────────────────────────────────
//
// `troughStart` is the instant a sentence quotes, and it is NOT the window the verdict
// rests on. The verdict's comparison excludes anything overlapping the claim, which is
// right for deciding and wrong for reporting: when the clock error is shorter than the
// session, the real trough overlaps the claim and is excluded, so the reported instant
// is displaced away from the onset by however far the exclusion pushes it.
describe("troughStart names where the body settled", () => {
  // A 420-minute night claimed four hours late. The real trough overlaps the claim, so
  // the verdict's own comparison cannot see it; the report has to.
  const CLAIM = { start: "2026-08-29T07:00:00Z", end: "2026-08-29T14:00:00Z" };
  const REAL = { from: "2026-08-29T03:00:00Z", to: "2026-08-29T10:00:00Z" };
  const trace4h = trace("2026-08-28T11:00:00Z", "2026-08-30T10:00:00Z", REAL);

  it("names the real onset even when the trough overlaps the claim", () => {
    const found = detectSleepClockSkew(CLAIM, trace4h);
    expect(found).not.toBeNull();
    const at = Date.parse(found!.troughStart);
    // Inside the real trough, not hours before it. The non-overlapping best for this
    // shape lands at 00:00Z — three hours early, 43% of the session's width — which is
    // what this exists to stop the copy quoting.
    expect(at).toBeGreaterThanOrEqual(Date.parse(REAL.from));
    expect(at).toBeLessThan(Date.parse(REAL.to));
  });

  it("leaves the VERDICT's own numbers alone", () => {
    // Only the quoted instant is re-derived. `claimedBpm` and `troughBpm` are the
    // comparison the finding rests on and must not move with it.
    const found = detectSleepClockSkew(CLAIM, trace4h)!;
    expect(found.claimedBpm).toBe(AWAKE);
    expect(found.troughBpm).toBe(ASLEEP);
    expect(found.start).toBe(CLAIM.start);
    expect(found.end).toBe(CLAIM.end);
  });

  it("still names the onset when the shift is LONGER than the night", () => {
    // The case that was already exact, kept as the control: with no overlap the two
    // derivations agree, so this must not have moved.
    const found = detectSleepClockSkew(
      SKEWED_SESSION,
      trace(DAY_FROM, DAY_TO, {
        from: "2026-08-30T03:39:00Z",
        to: "2026-08-30T08:37:00Z",
      })
    )!;
    const at = Date.parse(found.troughStart);
    expect(at).toBeGreaterThanOrEqual(Date.parse("2026-08-30T03:39:00Z"));
    expect(at).toBeLessThan(Date.parse("2026-08-30T08:37:00Z"));
  });

  it("reports nothing extra on a night that does not flag", () => {
    // The second pass runs only after a verdict, so a quiet night pays none of it and
    // returns null exactly as before.
    expect(
      detectSleepClockSkew(
        SKEWED_SESSION,
        trace(DAY_FROM, DAY_TO, {
          from: SKEWED_SESSION.start,
          to: SKEWED_SESSION.end,
        })
      )
    ).toBeNull();
  });
});
