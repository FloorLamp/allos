import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  NAV_PROGRESS_THRESHOLD_MS,
  awaitNavRetry,
  failNavProgress,
  getNavProgress,
  getServerNavProgress,
  navProgressPhase,
  resetNavProgress,
  retryNavProgress,
  settleNavProgress,
  startNavProgress,
  subscribeNavProgress,
} from "@/lib/nav-progress";

describe("navProgressPhase", () => {
  it("is idle when nothing is navigating", () => {
    expect(
      navProgressPhase({ navigating: false, elapsedMs: 5000, failed: false })
    ).toBe("idle");
  });

  it("paints nothing under the threshold, so a fast network sees no flash", () => {
    expect(
      navProgressPhase({
        navigating: true,
        elapsedMs: NAV_PROGRESS_THRESHOLD_MS - 1,
        failed: false,
      })
    ).toBe("waiting");
  });

  it("shows the indicator at the threshold", () => {
    expect(
      navProgressPhase({
        navigating: true,
        elapsedMs: NAV_PROGRESS_THRESHOLD_MS,
        failed: false,
      })
    ).toBe("slow");
  });

  it("reports a failure that arrives before the threshold", () => {
    // A dead connection rejects almost instantly, so the ask has to be reachable
    // without first waiting out a threshold meant for slowness.
    expect(
      navProgressPhase({ navigating: true, elapsedMs: 10, failed: true })
    ).toBe("failed");
  });
});

describe("the navigation progress store", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    resetNavProgress();
  });

  afterEach(() => {
    resetNavProgress();
    vi.useRealTimers();
  });

  it("starts idle, and reports idle to the server renderer", () => {
    expect(getNavProgress()).toBe("idle");
    expect(getServerNavProgress()).toBe("idle");
  });

  it("stays silent until the threshold has passed", () => {
    startNavProgress();
    expect(getNavProgress()).toBe("waiting");
    vi.advanceTimersByTime(NAV_PROGRESS_THRESHOLD_MS - 1);
    expect(getNavProgress()).toBe("waiting");
    vi.advanceTimersByTime(1);
    expect(getNavProgress()).toBe("slow");
  });

  it("paints nothing at all for a navigation that commits under the threshold", () => {
    const seen: string[] = [];
    subscribeNavProgress(() => seen.push(getNavProgress()));
    startNavProgress();
    vi.advanceTimersByTime(NAV_PROGRESS_THRESHOLD_MS - 50);
    settleNavProgress();
    vi.advanceTimersByTime(1000);
    expect(seen).toEqual(["waiting", "idle"]);
    expect(getNavProgress()).toBe("idle");
  });

  it("notifies subscribers only when the phase actually changes", () => {
    const listener = vi.fn();
    subscribeNavProgress(listener);
    startNavProgress();
    startNavProgress();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it("drops a subscriber that unsubscribes", () => {
    const listener = vi.fn();
    const unsubscribe = subscribeNavProgress(listener);
    unsubscribe();
    startNavProgress();
    expect(listener).not.toHaveBeenCalled();
  });

  it("reports a failure immediately, without waiting out the threshold", () => {
    startNavProgress();
    failNavProgress();
    expect(getNavProgress()).toBe("failed");
    // The threshold timer must not fire behind the failure and claim the
    // navigation is merely slow.
    vi.advanceTimersByTime(NAV_PROGRESS_THRESHOLD_MS * 4);
    expect(getNavProgress()).toBe("failed");
  });

  it("resumes a held navigation on retry, and resolves the fetch that was waiting", async () => {
    startNavProgress();
    let resumed = false;
    const held = awaitNavRetry().then(() => {
      resumed = true;
    });
    failNavProgress();

    retryNavProgress();
    await held;
    expect(resumed).toBe(true);
    // Back to `slow`, not `waiting`: the person has already waited past the
    // threshold, and dropping under it would blank the indicator mid-navigation.
    expect(getNavProgress()).toBe("slow");
  });

  it("ignores a retry when nothing has failed", () => {
    startNavProgress();
    vi.advanceTimersByTime(NAV_PROGRESS_THRESHOLD_MS);
    retryNavProgress();
    expect(getNavProgress()).toBe("slow");
  });

  it("leaves a superseded navigation's held fetch parked forever", async () => {
    startNavProgress();
    let resumed = false;
    void awaitNavRetry().then(() => {
      resumed = true;
    });
    failNavProgress();

    // A second navigation starts. React has already discarded the transition
    // that was waiting on the held fetch, so resuming it would land a page
    // nobody asked for any more.
    startNavProgress();
    retryNavProgress();
    await Promise.resolve();
    expect(resumed).toBe(false);
    expect(getNavProgress()).toBe("waiting");
  });

  it("clears the failure when the destination finally commits", () => {
    startNavProgress();
    failNavProgress();
    settleNavProgress();
    expect(getNavProgress()).toBe("idle");
  });
});
