import { describe, it, expect } from "vitest";
import { HAPTIC_PATTERNS, hapticPattern, type HapticEvent } from "@/lib/haptics";

describe("hapticPattern", () => {
  it("gives a set check-off a single short tick", () => {
    expect(hapticPattern("set-logged", { reduceMotion: false })).toEqual([18]);
  });

  it("gives a timer ending a distinct double-pulse", () => {
    expect(hapticPattern("timer-complete", { reduceMotion: false })).toEqual([
      120, 60, 120,
    ]);
  });

  it("suppresses every cue under prefers-reduced-motion (#1307)", () => {
    for (const event of Object.keys(HAPTIC_PATTERNS) as HapticEvent[]) {
      expect(hapticPattern(event, { reduceMotion: true })).toBeNull();
    }
  });

  it("keeps the cues distinguishable — a tick is never mistakable for a completion", () => {
    // The value of the set is that a pocket can tell them apart: the completion cue
    // pulses more than once, the tick exactly once and much shorter.
    const tick = hapticPattern("set-logged", { reduceMotion: false })!;
    const done = hapticPattern("timer-complete", { reduceMotion: false })!;
    expect(tick).toHaveLength(1);
    expect(done.length).toBeGreaterThan(1);
    expect(tick[0]).toBeLessThan(done[0]);
  });

  it("emits only well-formed, non-negative millisecond patterns", () => {
    for (const pattern of Object.values(HAPTIC_PATTERNS)) {
      expect(pattern.length).toBeGreaterThan(0);
      // Vibration patterns alternate on/off, so an even length ends on a pause — always
      // finish on a buzz.
      expect(pattern.length % 2).toBe(1);
      for (const ms of pattern) expect(ms).toBeGreaterThan(0);
    }
  });
});
