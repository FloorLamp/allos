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
