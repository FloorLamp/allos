// Haptic (Vibration API) patterns — the app's whole haptic vocabulary (#1422, #3699).
//
// Two rules live here, both pure:
//   1. WHICH pattern a given cue uses. The patterns must stay mutually distinguishable
//      through a pocket — which is a property of the SET, not of any one call site.
//      Two components had already hand-copied `[120, 60, 120]` (RestTimer,
//      FitnessTestTimer); that's the one-computation rule at the pattern layer.
//   2. WHETHER to vibrate at all. `prefers-reduced-motion: reduce` suppresses it (the
//      #1307 posture — the request is about motion the body feels, and a buzz is exactly
//      that). Vibration is ADDITIVE only: the visual timer/checkbox/toast is always the
//      source of truth, so suppressing loses nothing.
//
// FOUR CUES, NAMED FOR WHAT HAPPENED rather than for where they fire (#3699). The cue
// used to be picked at the call site, which is why haptics reached exactly four places
// in three years: growing that way means a `haptic()` call in a few hundred components
// each choosing its own pattern, which is the hand-copied-literal problem #1422 was
// filed to end, one scale up. So the cues mount on the substrates every action already
// flows through — the toast provider, and the gesture recognizers — and no feature
// component ever names a pattern.
//
// Absent APIs are handled at the edge (`components/useHaptics.ts` — `navigator.vibrate?.`
// inside a try/catch), never here; this module never touches a browser global. iOS ships
// no Vibration API at all, in Safari or in an installed PWA, so on a large share of the
// phones this vocabulary exists for it never fires once — which is exactly why the
// never-the-only-carrier rule is a contract and not a nicety.

// Milliseconds, in the Vibration API's on/off/on… alternating form.
export const HAPTIC_PATTERNS = {
  // A discrete choice changed under your finger — a segment, a category chip, the jump
  // rail crossing a month, a sheet passing the point where letting go dismisses it. The
  // shortest cue in the set by design: it fires REPEATEDLY inside one continuous drag,
  // so anything longer would run together into a buzz, and a rail that buzzes is a rail
  // nobody scrubs. 8 ms is the #2657 ruling's own number.
  select: [8],
  // A write landed. One short, unobtrusive tick — deliberately far shorter than `alert`
  // so a confirmation never reads as a demand for attention.
  commit: [18],
  // The action failed or was refused, and this is the one cue with nothing to inherit.
  //
  // IT IS DISTINGUISHED BY PULSE COUNT, NOT BY LENGTH, which is the same argument
  // `alert` already makes against `commit`: through a pocket, "how many times did it
  // buzz" survives a crude motor and a thick coat, while "was that 18 ms or 40" does
  // not. So `commit` is one pulse, `alert` is two long ones, and this is THREE short
  // ones — the two cues that answer the same gesture cannot be confused by count.
  reject: [30, 40, 30, 40, 30],
  // A countdown reached zero (rest between sets, a timed fitness test) — a distinct
  // double-pulse, the "look at me" cue, and the only one you are meant to feel while
  // not looking at the screen.
  alert: [120, 60, 120],
} as const satisfies Record<string, readonly number[]>;

export type HapticEvent = keyof typeof HAPTIC_PATTERNS;

// THE TONE EACH CUE PLAYS (#5900), keyed by the same events so a tone and a buzz can
// never disagree about which cue a moment carries. Sound is the one carrier iOS has:
// it ships no Vibration API, so on an iPhone a landed write is otherwise felt by no
// one who is not looking. On by default with no setting (owner ruling 2026-09-12);
// the phone's mute is the off-switch. `prefers-reduced-motion` does not govern it —
// a tone is not motion.
//
// DISTINGUISHED BY PITCH AND LENGTH, the audio form of the pulse-count argument above:
// through a phone speaker "high and short" versus "low and longer" survives a noisy
// room where a gain difference does not. Every pitch sits at or above 440 Hz because
// a phone speaker barely reproduces anything below that.
//
// `hz` is the sine's frequency, `seconds` its length from start to silence, and
// `gain` the envelope's peak (0–1) before the destination's own volume.
export const HAPTIC_TONES = {
  // Fires repeatedly inside one drag; a tone per segment would chatter. Silent.
  select: null,
  // A write landed: a short, high, quiet tick. The quietest and shortest tone in the
  // set by design, so a confirmation never reads as a demand for attention.
  commit: { hz: 1320, seconds: 0.08, gain: 0.05 },
  // Refused: an octave and a half below `commit` and twice as long, so the two answers
  // to the same tap cannot be mistaken for each other.
  reject: { hz: 440, seconds: 0.16, gain: 0.08 },
  // A countdown ended: the timers' original 880 Hz / 0.4 s cue, unchanged, and the
  // loudest and longest tone in the set, since it is meant to be heard off-screen.
  alert: { hz: 880, seconds: 0.4, gain: 0.2 },
} as const satisfies Record<
  HapticEvent,
  { hz: number; seconds: number; gain: number } | null
>;

// The pattern to pass to `navigator.vibrate`, or null when the cue is suppressed.
// `reduceMotion` is the viewer's `prefers-reduced-motion: reduce` match.
export function hapticPattern(
  event: HapticEvent,
  opts: { reduceMotion: boolean }
): readonly number[] | null {
  if (opts.reduceMotion) return null;
  return HAPTIC_PATTERNS[event];
}

// WHICH CUE A TOAST CARRIES, or null for none (#3699). The toast provider is the one
// place every announced write in the app already passes through (#1315, ~105 callers),
// so mounting `commit`/`reject` there gives every one of them a confirmation your hand
// can feel without changing a single call site.
//
// `silent` is the declared exception and it is about WHOSE action it was. A headless
// poster — extraction finishing, an import job, autosave on a timer, the offline queue
// replaying after connectivity returns — announces something the person did not just
// do, and a phone that buzzes while it sits on a table is worse than one that never
// buzzes at all. Those posters say `silent: true`; a feature component never thinks
// about it.
export function toastHaptic(opts: {
  tone?: "success" | "error";
  silent?: boolean;
}): HapticEvent | null {
  if (opts.silent) return null;
  return opts.tone === "error" ? "reject" : "commit";
}
