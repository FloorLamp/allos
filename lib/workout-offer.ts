// The workout entry affordance's offer state (issue #1893, following #1892's shape).
//
// "Start workout" was rendered UNCONDITIONALLY by every entry point — the mobile bar's
// bolt, the command palette's live action, the Journal aside, and the routine card's
// "Log this session" — while `openLive()`/`openSession()` unconditionally cleared the
// editor and re-stamped `liveStartEpoch = Date.now()`. The #921 dock carries a MINIMIZED
// live session whose elapsed timer ticks off exactly that epoch, so a mid-workout tap
// reset the session clock and stomped its state: silent corruption of in-progress work,
// not an honest refusal.
//
// This is the ONE derivation of "is a session live, and therefore what may this
// affordance offer" (#221). Four surfaces render it and the provider's own open* guards
// enforce it, so a label and the write it performs can never disagree, and a stale caller
// cannot stomp a running session either.
//
// Pure: no DB, no clock, no React. The provider supplies the two facts it already holds.

export interface WorkoutOfferInput {
  // A live session is MOUNTED in this client — the live editor is open, whether shown
  // full-screen or collapsed to the #921 dock bar (minimizing keeps ActivityForm mounted,
  // so the rest timer and elapsed clock are still running).
  mounted: boolean;
  // No live session is mounted here, but the server-hydrated #921 presence says one is
  // ACTIVE and its #451 draft is reopenable — the fresh-load / other-device case, where
  // the dock bar is hydrated from `liveStartEpochMs` rather than from client state.
  hydrated: boolean;
}

// Where a resume must reopen FROM. The distinction matters because it decides what
// happens to the session clock: a mounted session is un-hidden with its epoch UNTOUCHED,
// while a hydrated one is re-seeded from the server's recorded start instant. Neither
// path may take a fresh `Date.now()`.
export type WorkoutResumeSource = "mounted" | "hydrated";

export const START_WORKOUT_LABEL = "Start workout";
export const RESUME_WORKOUT_LABEL = "Resume workout";

export type WorkoutOffer =
  // Nothing is running: the tap starts a new live session (the pre-#1893 behavior, now
  // reached only when it is actually correct).
  | { kind: "start"; label: typeof START_WORKOUT_LABEL }
  // A session IS running: the tap reopens it. The label names the write it will perform,
  // exactly as #1892 requires of the cycle control.
  | {
      kind: "resume";
      label: typeof RESUME_WORKOUT_LABEL;
      from: WorkoutResumeSource;
    };

// The offer for the current session state. A MOUNTED session wins over a hydrated one:
// the mounted form holds the user's unsaved in-flight input and its live rest timer, so
// re-hydrating from the persisted draft would throw that away — the same class of loss
// this issue exists to stop.
export function workoutOffer(input: WorkoutOfferInput): WorkoutOffer {
  if (input.mounted)
    return { kind: "resume", label: RESUME_WORKOUT_LABEL, from: "mounted" };
  if (input.hydrated)
    return { kind: "resume", label: RESUME_WORKOUT_LABEL, from: "hydrated" };
  return { kind: "start", label: START_WORKOUT_LABEL };
}
