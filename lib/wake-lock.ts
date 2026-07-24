// The screen-wake-lock hold/release decision (issue #1422), extracted PURE so the
// tier that can actually pin it does.
//
// The browser side of a wake lock is three interacting facts — does the surface WANT
// the screen held (the live workout editor is open and not minimized to the dock, the
// fitness-check takeover is expanded), does this navigator even HAVE the API, and is
// the document currently foregrounded (the UA auto-releases the sentinel on hide, so a
// held-while-hidden lock is a lie we have to re-acquire out of). Every one of those got
// re-derived inline inside a `useEffect` before, which is why "release when minimized"
// was missing: the effect only keyed on mount/unmount, and the dock keeps the editor
// MOUNTED. One function, one answer; `components/useWakeLock.ts` is the thin adapter
// that feeds it real `navigator`/`document` state and performs the returned action.

export type WakeLockState = {
  // The surface wants the screen awake right now (open AND foregrounded in its own
  // terms — e.g. not minimized to the dock).
  wanted: boolean;
  // `navigator.wakeLock` exists. Absent on desktop Firefox/iOS Safari — silent no-op.
  supported: boolean;
  // `document.visibilityState === "visible"`.
  visible: boolean;
  // We believe we hold a sentinel.
  held: boolean;
};

// What the adapter should do this pass. "none" covers both steady states (holding what
// we want, holding nothing when we want nothing).
export type WakeLockAction = "acquire" | "release" | "none";

// Whether a lock SHOULD be held given the current facts. Split out from the action so a
// caller can render/assert the intent without inferring it from a transition.
export function shouldHoldWakeLock(
  s: Pick<WakeLockState, "wanted" | "supported" | "visible">
): boolean {
  return s.wanted && s.supported && s.visible;
}

// The transition to perform. Releasing while hidden is deliberate and idempotent: the UA
// has already dropped the sentinel by then, so this just syncs our own bookkeeping and
// makes the next `visible` a clean "acquire" rather than a silently-dead hold.
export function wakeLockAction(s: WakeLockState): WakeLockAction {
  const hold = shouldHoldWakeLock(s);
  if (hold && !s.held) return "acquire";
  if (!hold && s.held) return "release";
  return "none";
}
