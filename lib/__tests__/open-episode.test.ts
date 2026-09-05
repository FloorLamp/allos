import { describe, expect, it } from "vitest";
import {
  EPISODE_BOUNDS,
  episodeIsOpen,
  episodeState,
  type EpisodeKind,
  type OpenEpisode,
} from "../open-episode";

// The ONE reading of "is this still going?" (#5142). Pure: every case states the
// instants it judges, so the three domains that share this model can be pinned
// against each other rather than each against its own copy of the bound.

const NOW = Date.parse("2026-09-04T18:00:00Z");
const MIN = 60_000;

function episode(
  kind: EpisodeKind,
  quietMin: number,
  expectedEnd: number | null = null
): OpenEpisode {
  return { kind, lastSignalAt: NOW - quietMin * MIN, expectedEnd };
}

describe("the bounds table", () => {
  it("holds the four values the domains used to declare themselves", () => {
    expect(EPISODE_BOUNDS.practice).toEqual({ staleMin: 360, abandonMin: 360 });
    expect(EPISODE_BOUNDS.workout).toEqual({ staleMin: 45, abandonMin: 90 });
    expect(EPISODE_BOUNDS.fast).toEqual({ staleMin: 2160, abandonMin: null });
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
