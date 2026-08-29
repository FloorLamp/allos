import { describe, it, expect } from "vitest";
import {
  HAPTIC_PATTERNS,
  hapticPattern,
  toastHaptic,
  type HapticEvent,
} from "@/lib/haptics";

describe("hapticPattern", () => {
  it.each([
    ["select", [8]],
    ["commit", [18]],
    ["reject", [30, 40, 30, 40, 30]],
    ["alert", [120, 60, 120]],
  ] as [HapticEvent, number[]][])("gives %s its pattern", (event, pattern) => {
    expect(hapticPattern(event, { reduceMotion: false })).toEqual(pattern);
  });

  it("holds exactly the four cues and nothing else", () => {
    expect(Object.keys(HAPTIC_PATTERNS).sort()).toEqual([
      "alert",
      "commit",
      "reject",
      "select",
    ]);
  });

  it("suppresses every cue under prefers-reduced-motion (#1307)", () => {
    for (const event of Object.keys(HAPTIC_PATTERNS) as HapticEvent[]) {
      expect(hapticPattern(event, { reduceMotion: true })).toBeNull();
    }
  });

  // The value of the set is that a POCKET can tell the cues apart, and the strong
  // argument is PULSE COUNT — how many times it buzzed survives a crude motor and a
  // coat, where "was that 18 ms or 40" does not.
  //
  // IT IS NOT UNIFORM ACROSS THE FOUR, and pretending it were is how this assertion
  // first went green on a claim it could not make. `select` and `commit` are BOTH
  // single ticks on purpose: `select` fires repeatedly inside one continuous drag, so
  // it must be the shortest thing the set has, and lengthening it to buy a count
  // difference would turn a scrub into a buzz. They are separated by length, and by
  // never answering the same kind of event. The pairs that must survive a pocket —
  // a write landing against a write REFUSED, and either against a countdown ending —
  // are separated by count.
  it("keeps the cues that share a surface distinguishable by pulse count", () => {
    const pulses = (event: HapticEvent) =>
      Math.ceil(hapticPattern(event, { reduceMotion: false })!.length / 2);
    expect(pulses("commit")).toBe(1);
    expect(pulses("reject")).toBe(3);
    expect(pulses("alert")).toBe(2);
    // The one pair that shares a count is separated by length, in the direction the
    // drag requires.
    expect(pulses("select")).toBe(pulses("commit"));
    expect(HAPTIC_PATTERNS.select[0]).toBeLessThan(HAPTIC_PATTERNS.commit[0]);
    // And the attention cue's pulses are longer than every other cue's.
    for (const event of ["select", "commit", "reject"] as HapticEvent[])
      expect(HAPTIC_PATTERNS[event][0]).toBeLessThan(HAPTIC_PATTERNS.alert[0]);
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

describe("toastHaptic", () => {
  it.each([
    ["the default tone confirms", {}, "commit"],
    ["an explicit success confirms", { tone: "success" as const }, "commit"],
    ["an error is refused out loud", { tone: "error" as const }, "reject"],
    ["a headless poster is silent", { silent: true }, null],
    ["silence beats the tone", { tone: "error" as const, silent: true }, null],
  ] as [
    string,
    { tone?: "success" | "error"; silent?: boolean },
    HapticEvent | null,
  ][])("%s", (_name, options, expected) => {
    expect(toastHaptic(options)).toBe(expected);
  });
});
