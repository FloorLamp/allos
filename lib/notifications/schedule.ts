// Pure scheduling helpers for the hourly notify tick (no DB/network), so they can
// be unit-tested.

// Whether a slot scheduled for `slotHour` (0–23) is due at the current local hour.
// The window is [slotHour, slotHour+1] rather than exact equality so that:
//  - a DST spring-forward that skips the slot's exact hour still fires the slot in
//    the following hour (the documented "retry can recover" path), and
//  - a send that failed at slotHour gets one automatic retry the next hour.
// The per-day dedup (notify_last_<slot>) prevents a double send across the window.
// The retry hour deliberately does NOT wrap past midnight: hour 0 is the next
// calendar day, where the per-day dedup key is fresh — a wrapped slot-23 retry
// would fire at midnight, get marked sent for the new day, and suppress that
// day's real 23:00 send, permanently drifting the slot to midnight. DST
// transitions never occur at midnight, so the wrap isn't needed for the
// spring-forward case.
export function slotDue(slotHour: number, currentHour: number): boolean {
  return currentHour === slotHour || currentHour === slotHour + 1;
}

// The humane waking window (profile-local hours) the non-time-critical EPISODE
// nudges are held to (issue #378). Unlike the dose/digest/workout/recap slots,
// the refill, preventive, and milestone nudges have no slot of their own — they
// are evaluated on every hourly tick and would otherwise fire the instant an
// episode becomes due: at the local-midnight date rollover (a preventive rule
// flips "due"), or 1-3am after a late Strava/Oura sync or a late button-tap that
// crosses a threshold. None of them is time-critical, so hold them to a waking
// window; their once-per-episode dedup semantics are unchanged — the FIRST send
// simply waits for a reasonable hour. Bounds are inclusive: a nudge may land from
// WAKING_START_HOUR:00 through WAKING_END_HOUR:59 profile-local.
export const WAKING_START_HOUR = 8;
export const WAKING_END_HOUR = 21;

// Whether the given profile-local hour (0-23) is inside the waking window. The
// safety-tier senders (scheduled dose reminders, missed-dose escalation) are NOT
// gated by this — a possibly-critical medication signal must not be silenced by
// quiet hours; only the non-safety episode nudges consult it.
export function inWakingWindow(
  currentHour: number,
  startHour = WAKING_START_HOUR,
  endHour = WAKING_END_HOUR
): boolean {
  return currentHour >= startHour && currentHour <= endHour;
}
