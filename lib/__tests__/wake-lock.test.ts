import { describe, it, expect } from "vitest";
import {
  shouldHoldWakeLock,
  wakeLockAction,
  type WakeLockState,
} from "@/lib/wake-lock";

// The live-workout screen wake lock (#1422). The whole point of pulling this out is that
// the previous inline version keyed only on mount/unmount, so the dock — which keeps the
// editor MOUNTED while minimized — held the lock forever.

const base: WakeLockState = {
  wanted: true,
  supported: true,
  visible: true,
  held: false,
};

describe("shouldHoldWakeLock", () => {
  it("holds only when the surface wants it, the API exists, and the doc is visible", () => {
    expect(shouldHoldWakeLock(base)).toBe(true);
    expect(shouldHoldWakeLock({ ...base, wanted: false })).toBe(false);
    expect(shouldHoldWakeLock({ ...base, supported: false })).toBe(false);
    expect(shouldHoldWakeLock({ ...base, visible: false })).toBe(false);
  });
});

describe("wakeLockAction", () => {
  it("acquires when wanted and not yet held", () => {
    expect(wakeLockAction(base)).toBe("acquire");
  });

  it("is a no-op once the wanted lock is held", () => {
    expect(wakeLockAction({ ...base, held: true })).toBe("none");
  });

  it("releases when the editor is minimized to the dock (still mounted, no longer wanted)", () => {
    expect(wakeLockAction({ ...base, wanted: false, held: true })).toBe(
      "release"
    );
  });

  it("releases when the tab is backgrounded, then re-acquires on return", () => {
    // The UA drops the sentinel on hide; we sync our own bookkeeping so the next
    // foreground pass is a clean acquire rather than a silently-dead hold.
    expect(wakeLockAction({ ...base, visible: false, held: true })).toBe(
      "release"
    );
    expect(wakeLockAction({ ...base, visible: true, held: false })).toBe(
      "acquire"
    );
  });

  it("never acts on a navigator without the API", () => {
    expect(wakeLockAction({ ...base, supported: false })).toBe("none");
    // Even a stale held flag can't produce a call we couldn't have made.
    expect(wakeLockAction({ ...base, supported: false, held: true })).toBe(
      "release"
    );
  });

  it("does nothing when nothing is wanted and nothing is held", () => {
    expect(wakeLockAction({ ...base, wanted: false })).toBe("none");
  });
});
