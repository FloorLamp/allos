import { describe, expect, it } from "vitest";
import { shiftDateStr } from "../date";
import {
  dayEpisodeClaimEnd,
  dayEpisodeState,
  EPISODE_BOUNDS,
  EPISODE_DAY_BOUNDS,
  episodeIsOpen,
  episodeState,
  type MinuteEpisodeKind,
  type OpenEpisode,
} from "../open-episode";

// The ONE reading of "is this still going?" (#5142). Pure: every case states the
// instants it judges, so the three domains that share this model can be pinned
// against each other rather than each against its own copy of the bound.

const NOW = Date.parse("2026-09-04T18:00:00Z");
const MIN = 60_000;

function episode(
  kind: MinuteEpisodeKind,
  quietMin: number,
  expectedEnd: number | null = null
): OpenEpisode {
  return { kind, lastSignalAt: NOW - quietMin * MIN, expectedEnd };
}

describe("the bounds table", () => {
  it("holds the values the domains used to declare themselves", () => {
    expect(EPISODE_BOUNDS.practice.abandonMin).toBe(360);
    expect(EPISODE_BOUNDS.workout).toEqual({ staleMin: 45, abandonMin: 90 });
    expect(EPISODE_BOUNDS.fast).toEqual({ staleMin: 2160, abandonMin: null });
  });

  // THE ONE NUMBER IN THIS TABLE NO DOMAIN BROUGHT WITH IT (#5142 AC 3). Practice
  // arrived with a single six-hour bound doing both jobs, because it had no
  // "Still going?" to send and a suggest nobody sends needs no window to be sent in.
  // Giving it one meant choosing a stale bound, and 90 is that choice: past every
  // practice this app is a logger for, and far enough inside the abandon bound that
  // the person has four and a half hours to answer before the sweep clears the row.
  it("gives practice a real stale window inside its unchanged abandon bound", () => {
    expect(EPISODE_BOUNDS.practice).toEqual({ staleMin: 90, abandonMin: 360 });
    expect(EPISODE_BOUNDS.practice.staleMin).toBeLessThan(
      EPISODE_BOUNDS.practice.abandonMin
    );
    expect(episodeState(episode("practice", 89.99), NOW).kind).toBe("running");
    expect(episodeState(episode("practice", 90), NOW).kind).toBe("stale");
    expect(episodeState(episode("practice", 360), NOW).kind).toBe("stale");
    expect(episodeState(episode("practice", 360.01), NOW).kind).toBe(
      "abandoned"
    );
  });
});

describe("one comparison convention across the kinds", () => {
  it("reaches STALE at the bound — the suggest fires on arrival", () => {
    for (const kind of ["practice", "workout", "fast"] as const) {
      const { staleMin } = EPISODE_BOUNDS[kind];
      expect(episodeState(episode(kind, staleMin - 0.01), NOW).kind).toBe(
        "running"
      );
      expect(episodeState(episode(kind, staleMin), NOW).kind).toBe("stale");
    }
  });

  it("must PASS the abandon bound before the app gives up", () => {
    const { abandonMin } = EPISODE_BOUNDS.workout;
    expect(episodeState(episode("workout", abandonMin), NOW).kind).toBe(
      "stale"
    );
    expect(episodeState(episode("workout", abandonMin + 0.01), NOW).kind).toBe(
      "abandoned"
    );
  });

  it("reports the quiet it measured on every open reading", () => {
    expect(episodeState(episode("workout", 12), NOW)).toEqual({
      kind: "running",
      quietMin: 12,
    });
    expect(episodeState(episode("workout", 50), NOW)).toEqual({
      kind: "stale",
      quietMin: 50,
    });
  });
});

describe("stale is still open", () => {
  it("holds a quiet draft open for the tick to nudge inside", () => {
    const state = episodeState(episode("workout", 60), NOW);
    expect(state.kind).toBe("stale");
    expect(episodeIsOpen(state)).toBe(true);
  });

  it("closes only once the episode is abandoned or finished", () => {
    expect(episodeIsOpen(episodeState(episode("workout", 200), NOW))).toBe(
      false
    );
    expect(
      episodeIsOpen(episodeState(episode("practice", 30, NOW - MIN), NOW))
    ).toBe(false);
  });
});

describe("a kind with no abandon bound", () => {
  it("leaves a ten-day fast stale rather than closing it", () => {
    // Only the person knows whether they stopped or never started, so nothing here
    // may auto-end a fast however implausible it has become.
    const state = episodeState(episode("fast", 10 * 24 * 60), NOW);
    expect(state.kind).toBe("stale");
    expect(episodeIsOpen(state)).toBe(true);
  });

  it("does not abandon a fast whose evidence is dated in the future", () => {
    expect(episodeState(episode("fast", -30), NOW).kind).toBe("running");
  });
});

describe("quiet is the only question this model asks", () => {
  it("reads evidence dated ahead of the clock as running, for every kind", () => {
    // An episode whose freshest evidence is in the future has not gone quiet at
    // all. Whether that evidence is PLAUSIBLE is a claim about the row — a
    // wall-clock start stranded by a timezone edit is not the same as a server
    // stamp a few seconds ahead — so the domain that stores it asks that, and this
    // model does not silently apply one tolerance to both.
    for (const kind of ["practice", "workout", "fast"] as const)
      expect(episodeState(episode(kind, -30), NOW).kind).toBe("running");
  });
});

describe("an episode that knows its own end", () => {
  it("is finished at that end, and no bound reaches it first", () => {
    // Twelve hours quiet — twice the practice bound — and it still finished at
    // 06:43 rather than being swept with the end discarded.
    const startedAt = NOW - 12 * 60 * MIN;
    const state = episodeState(
      {
        kind: "practice",
        lastSignalAt: startedAt,
        expectedEnd: startedAt + 15 * MIN,
      },
      NOW
    );
    expect(state).toEqual({ kind: "finished", endedAt: startedAt + 15 * MIN });
  });

  it("finishes AT the expected end, not a moment later", () => {
    const end = NOW;
    expect(episodeState(episode("practice", 15, end), NOW).kind).toBe(
      "finished"
    );
    expect(episodeState(episode("practice", 15, end + 1), NOW).kind).toBe(
      "running"
    );
  });

  it("is still running while its expected end is ahead of it", () => {
    expect(
      episodeState(episode("practice", 15, NOW + 30 * MIN), NOW).kind
    ).toBe("running");
  });
});

// ── The day half (#5142 step 2) ─────────────────────────────────────────────────
//
// The same question in the other unit. These cases are stated in DAYS from a start
// date with no clock behind it, which is the whole reason the day half exists: ten
// local days is 240 hours only when no day is 23 or 25 hours long.

const PERIOD_START = shiftDateStr("2026-04-01", 0);

function periodOn(elapsedDays: number) {
  return dayEpisodeState(
    { kind: "period", lastSignalOn: PERIOD_START },
    shiftDateStr(PERIOD_START, elapsedDays)
  );
}

describe("the day bounds table", () => {
  it("holds the period's ten-day bound, with nothing to abandon it", () => {
    expect(EPISODE_DAY_BOUNDS.period).toEqual({
      staleDays: 10,
      abandonDays: null,
    });
  });
});

describe("a day-counted episode's quiet", () => {
  it("counts the signal day as day 1, so the bound is outrun on day 11", () => {
    expect(periodOn(9).kind).toBe("running");
    expect(periodOn(10).kind).toBe("stale");
  });

  it("turns stale on the day after the claim end, never before it", () => {
    // The claim cap and the state are one bound seen from two sides: the day the row
    // stops reading as running is the day after the last day it still claims. A lane
    // could otherwise put the right number in the table and the shift beside it.
    const claimEnd = dayEpisodeClaimEnd("period", PERIOD_START);
    for (let elapsed = 0; elapsed <= 20; elapsed++) {
      const on = shiftDateStr(PERIOD_START, elapsed);
      expect(periodOn(elapsed).kind === "stale").toBe(on > claimEnd);
    }
  });

  it("reports the days it measured on every reading", () => {
    expect(periodOn(3)).toEqual({ kind: "running", quietDays: 3 });
    expect(periodOn(12)).toEqual({ kind: "stale", quietDays: 12 });
  });

  it("reads a day before the start as running, as the minute half does", () => {
    expect(periodOn(-2)).toEqual({ kind: "running", quietDays: -2 });
  });
});

describe("a day kind with no abandon bound", () => {
  it("leaves a month-old open period stale rather than closing it", () => {
    // `abandonDays: null` is the same statement the fast's `abandonMin: null` makes:
    // only the person ends a period, however implausible the row has become.
    const state = periodOn(30);
    expect(state.kind).toBe("stale");
    expect(episodeIsOpen(state)).toBe(true);
  });
});

describe('one "still going?" predicate over both units', () => {
  it("answers for a day episode and keeps the arm it was handed", () => {
    const state = periodOn(2);
    expect(episodeIsOpen(state)).toBe(true);
    // The narrowing survives the generic: the caller reads the quiet it asked for
    // without re-testing the kind.
    if (episodeIsOpen(state)) expect(state.quietDays).toBe(2);
  });
});
