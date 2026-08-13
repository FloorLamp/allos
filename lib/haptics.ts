// Haptic (Vibration API) patterns for the phone-at-the-gym surfaces (issue #1422).
//
// Two rules live here, both pure:
//   1. WHICH pattern a given cue uses. The patterns must stay mutually distinguishable
//      through a pocket — a set check-off is a single short tick, a timer ending is a
//      DOUBLE pulse — which is a property of the set, not of any one call site. Two
//      components had already hand-copied `[120, 60, 120]` (RestTimer, FitnessTestTimer);
//      that's the one-computation rule at the pattern layer.
//   2. WHETHER to vibrate at all. `prefers-reduced-motion: reduce` suppresses it (the
//      #1307 posture — the request is about motion the body feels, and a buzz is exactly
//      that). Vibration is ADDITIVE only: the visual timer/checkbox state is always the
//      source of truth, so suppressing loses nothing.
//
// Absent APIs are handled at the edge (`components/useHaptics.ts` — `navigator.vibrate?.`),
// never here; this module never touches a browser global.

// Milliseconds, in the Vibration API's on/off/on… alternating form.
export const HAPTIC_PATTERNS = {
  // A set was checked off — one short, unobtrusive tick. Deliberately far shorter than
  // the completion cue so the two never read as the same event.
  "set-logged": [18],
  // A countdown reached zero (rest between sets, a timed fitness test) — a distinct
  // double-pulse, the "look at me" cue.
  "timer-complete": [120, 60, 120],
  // The timeline jump rail crossed a month boundary (#2657 item 4). The shortest cue in
  // the set by design: it fires REPEATEDLY inside one continuous drag — once per month
  // the finger passes — so anything longer would run together into a buzz, and a rail
  // that buzzes is a rail nobody scrubs. 8 ms is the #2657 ruling's own number.
  //
  // Additive in the strongest sense the set has seen: iOS ships no Vibration API at
  // all, so on a large share of the phones this rail exists for it never fires once.
  // The bubble's visual beat (MICRO_MOTIONS.tick) is the universal carrier, and the
  // bubble's text is the carrier under reduced motion, where this returns null.
  "scrubber-tick": [8],
} as const satisfies Record<string, readonly number[]>;

export type HapticEvent = keyof typeof HAPTIC_PATTERNS;

// The pattern to pass to `navigator.vibrate`, or null when the cue is suppressed.
// `reduceMotion` is the viewer's `prefers-reduced-motion: reduce` match.
export function hapticPattern(
  event: HapticEvent,
  opts: { reduceMotion: boolean }
): readonly number[] | null {
  if (opts.reduceMotion) return null;
  return HAPTIC_PATTERNS[event];
}
