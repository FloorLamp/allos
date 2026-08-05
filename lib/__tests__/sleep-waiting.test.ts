import { describe, expect, it } from "vitest";
import {
  isSleepTracking,
  sleepWaitingState,
  sleepWaitingDetail,
  ARRIVAL_GRACE_MIN,
  DEFAULT_ARRIVAL_LAG_MIN,
  MAX_WAITING_WINDOW_MIN,
  type SleepWaitingSignals,
} from "@/lib/sleep-waiting";
import { DEFAULT_WAKE_MINUTES } from "@/lib/now-strip";

// The morning waiting window (#2097). What these pin is the PRECEDENCE as much as
// the branches: "no last night, past typical wake" is true every morning after
// someone stops wearing their device, so a state machine that checks the clock
// before it checks whether anything is coming recurs daily instead of resolving.

const MIN = (h: number, m = 0) => h * 60 + m;
const WAKE = MIN(6, 0);

function signals(over: Partial<SleepWaitingSignals> = {}): SleepWaitingSignals {
  return {
    hasLastNight: false,
    minutesOfDay: MIN(6, 30),
    wakeMinutes: WAKE,
    tracking: true,
    arrivalLagMin: null,
    providerHealthy: true,
    lastCheckedAt: "2026-08-05 06:33:00",
    ...over,
  };
}

describe("isSleepTracking", () => {
  // Wake-day T is last night; the nights before it are T−1 … T−3.
  const T = "2026-08-05";
  const nights = (...backs: number[]) =>
    backs.map((b) => {
      const d = new Date(Date.UTC(2026, 7, 5) - b * 86400000);
      return d.toISOString().slice(0, 10);
    });

  it("is true when the three nights before last night are all recorded", () => {
    expect(isSleepTracking(nights(1, 2, 3), T)).toBe(true);
  });

  it("tolerates ONE forgotten charge behind an otherwise unbroken run", () => {
    // A hole at T−2 with T−1 recorded: a night off the wrist, not a stop.
    expect(isSleepTracking(nights(1, 3), T)).toBe(true);
  });

  it("stops the moment the gap is TWO nights deep", () => {
    // Last night is missing (that is why we are asking) and so is the night before
    // it. That is not "not synced yet", that is stopped — and this is what makes
    // the abandoned device produce the waiting state on ONE morning, not fourteen.
    expect(isSleepTracking(nights(2, 3), T)).toBe(false);
  });

  it("refuses a profile that was never in a daily rhythm", () => {
    // T−1 recorded but only one of three: nothing here is a nightly habit to be
    // waiting on.
    expect(isSleepTracking(nights(1), T)).toBe(false);
  });

  it("is false with nothing recorded at all", () => {
    expect(isSleepTracking([], T)).toBe(false);
  });

  it("ignores nights outside the lookback, including last night itself", () => {
    // Today's own wake-day says nothing about the three before it.
    expect(isSleepTracking([T, ...nights(5, 6, 7)], T)).toBe(false);
  });
});

describe("sleepWaitingState — precedence", () => {
  it("says nothing at all once last night is in hand", () => {
    expect(sleepWaitingState(signals({ hasLastNight: true }))).toBeNull();
  });

  it("says nothing when the profile is not sleep-tracking", () => {
    // The abandoned device: watch in a drawer, phone still syncing steps, provider
    // green. Checked BEFORE any clock branch, or it would ask again every morning.
    expect(sleepWaitingState(signals({ tracking: false }))).toBeNull();
  });

  it("says nothing when the provider is failing or stale", () => {
    // A broken connection has its own reconnect path and a different message.
    expect(sleepWaitingState(signals({ providerHealthy: false }))).toBeNull();
  });

  it("checks tracking even when the clock is deep in the waiting window", () => {
    expect(
      sleepWaitingState(signals({ minutesOfDay: MIN(6, 5), tracking: false }))
    ).toBeNull();
  });
});

describe("sleepWaitingState — the branches", () => {
  it("before the wake anchor, names the night in progress", () => {
    const s = sleepWaitingState(signals({ minutesOfDay: MIN(3, 12) }))!;
    expect(s.kind).toBe("in-progress");
    expect(s.headline).toBe("Tonight's sleep is still in progress");
  });

  it("resolves the pre-wake state from the clock alone", () => {
    // No usable typicalWakeTime (fewer than 14 nights) still gets the state, off
    // the shared default anchor — the anchor only BOUNDS a statement about data,
    // so it does not have to be right about this person to be safe.
    const s = sleepWaitingState(
      signals({ wakeMinutes: null, minutesOfDay: DEFAULT_WAKE_MINUTES - 1 })
    )!;
    expect(s.kind).toBe("in-progress");
    // …and it does not vary with the reader's sleep history.
    expect(
      sleepWaitingState(
        signals({ wakeMinutes: null, minutesOfDay: DEFAULT_WAKE_MINUTES + 1 })
      )!.kind
    ).not.toBe("in-progress");
  });

  it("inside the expected-arrival window, names the wait", () => {
    const s = sleepWaitingState(signals({ minutesOfDay: MIN(7, 0) }))!;
    expect(s.kind).toBe("waiting");
    expect(s.headline).toBe("Waiting for last night's sleep");
  });

  it("is still waiting at the exact edge of the window, and not past it", () => {
    const edge = WAKE + DEFAULT_ARRIVAL_LAG_MIN + ARRIVAL_GRACE_MIN;
    expect(sleepWaitingState(signals({ minutesOfDay: edge }))!.kind).toBe(
      "waiting"
    );
    expect(sleepWaitingState(signals({ minutesOfDay: edge + 1 }))!.kind).toBe(
      "not-synced"
    );
  });

  it("the window CLOSES — it never stays open all day", () => {
    // The whole difference between an informative state and a stuck one.
    const s = sleepWaitingState(
      signals({ minutesOfDay: MIN(16), arrivalLagMin: 600 })
    )!;
    expect(s.kind).toBe("not-synced");
    expect(s.headline).toBe("Last night hasn't synced");
    // Even an absurd measured lag cannot push the boundary past the cap.
    expect(
      sleepWaitingState(
        signals({
          minutesOfDay: WAKE + MAX_WAITING_WINDOW_MIN + 1,
          arrivalLagMin: 600,
        })
      )!.kind
    ).toBe("not-synced");
  });

  it("a measured lag widens the window to fit the profile's real rhythm", () => {
    // 150 min of measured lag: past the default bound, inside the measured one.
    const late = WAKE + DEFAULT_ARRIVAL_LAG_MIN + ARRIVAL_GRACE_MIN + 20;
    expect(sleepWaitingState(signals({ minutesOfDay: late }))!.kind).toBe(
      "not-synced"
    );
    expect(
      sleepWaitingState(signals({ minutesOfDay: late, arrivalLagMin: 150 }))!
        .kind
    ).toBe("waiting");
  });
});

describe("sleepWaitingDetail", () => {
  const fmt = {
    clock: (min: number) =>
      `${String(Math.floor(min / 60)).padStart(2, "0")}:${String(min % 60).padStart(2, "0")}`,
    when: (iso: string) => `at ${iso}`,
  };

  it("quotes the ETA only when the arrival sample supports one", () => {
    const measured = sleepWaitingState(
      signals({ minutesOfDay: MIN(6, 30), arrivalLagMin: 70 })
    )!;
    expect(measured.etaMinutes).toBe(WAKE + 70);
    expect(sleepWaitingDetail(measured, fmt)).toBe("Usually in by ~07:10");

    // Under the sample gate the query hands over null, and the copy degrades to the
    // plain wording rather than quoting a median built on three mornings.
    const unmeasured = sleepWaitingState(
      signals({ minutesOfDay: MIN(6, 30) })
    )!;
    expect(unmeasured.etaMinutes).toBeNull();
    expect(sleepWaitingDetail(unmeasured, fmt)).toBeNull();
  });

  it("names the last check on the not-synced state", () => {
    const s = sleepWaitingState(signals({ minutesOfDay: MIN(16) }))!;
    expect(sleepWaitingDetail(s, fmt)).toBe(
      "Last checked at 2026-08-05 06:33:00"
    );
  });

  it("says NOTHING extra while the night is in progress", () => {
    // Anything here would be a remark about the hour the reader is keeping, which
    // is the one thing this state must never make: the app cannot know why someone
    // is awake at 3am, and the likeliest reasons are the ones to be careful with.
    const s = sleepWaitingState(signals({ minutesOfDay: MIN(3) }))!;
    expect(sleepWaitingDetail(s, fmt)).toBeNull();
    expect(s.headline).not.toMatch(/you/i);
    expect(s.headline).not.toMatch(/usually|asleep/i);
  });
});
