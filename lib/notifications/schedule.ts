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
//
// These constants are now only the DEFAULT (issue #450): the window is a per-profile
// setting (`quiet_hours` in profile_settings, NotifySchedule.wakingStartHour/EndHour),
// so a night-shift household can shift it. A profile with no stored value falls back
// to exactly this default, so behavior is unchanged until it's edited.
export const WAKING_START_HOUR = 8;
export const WAKING_END_HOUR = 21;

// Default profile-local hours for scheduled intake reminders. Keep this in the
// pure scheduling layer so settings and onboarding restore the same defaults.
export const DEFAULT_INTAKE_REMINDER_HOURS = {
  Morning: 8,
  Midday: 13,
  Evening: 20,
  Bedtime: 22,
} as const;

// The PreWorkout pseudo-slot hour (issue #1154 Fix A): fire the hourly tick's
// pre-workout reminder one hour BEFORE the inferred training hour, so with the
// tick's :00 cadence the send lands ~30–60 min ahead of the session (inferred
// hour 18 → the 17:00 slot). Wraps at midnight defensively (an inferred hour of
// 0 → 23) — slotDue's no-wrap retry rule still applies to the resulting hour.
export function preWorkoutSlotHour(inferredWorkoutHour: number): number {
  return (inferredWorkoutHour + 23) % 24;
}

// The auto-hour sentinel stored in profile_settings (issue #1117) for a slot that
// should follow the profile's wake time. It is a KV VALUE, distinct from the three
// states the raw string already encodes — absent, "" (off), a number "N" (manual)
// — so "auto" is a fourth, explicit state the user chose. Kept here in the pure
// scheduling layer so the reader (getNotifySchedule) and the settings form agree.
export const AUTO_HOUR = "auto";

// Resolve a stored notify-hour value to a concrete 0-23 hour or null (off),
// mapping the wake-aware states (issue #1117). This is the ONE place the four raw
// states collapse, so the read side can't drift from the write side:
//   • undefined (absent, never configured) → `absentFallback`
//   • ""        (explicitly off)           → null
//   • "auto"    (follow wake time)         → `autoValue`
//   • "N" 0-23  (a specific hour the user picked, manual — always wins)
//   • anything else (corrupt)              → `absentFallback`
// `autoValue` defaults to `absentFallback`, so a slot whose default IS the
// wake-derived hour needs to pass it only once. A manual "N" is never overwritten
// by seeding — that's "seed the default, never move a time you've set."
export function parseNotifyHour(
  raw: string | undefined,
  absentFallback: number | null,
  autoValue: number | null = absentFallback
): number | null {
  if (raw === undefined) return absentFallback; // unset → default
  if (raw === "") return null; // explicitly off
  if (raw === AUTO_HOUR) return autoValue; // follow wake time
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : absentFallback;
}

// Whether the given profile-local hour (0-23) is inside the waking window (issue
// #378, made per-profile in #450). Inclusive on both bounds. A window that WRAPS
// past midnight (startHour > endHour, e.g. a night-shift 20→8 waking window) is
// supported: the hour is waking if it's at/after the start OR at/before the end.
// A same start/end is a literal one-hour window (an unlikely edge; the widest
// "no quiet hours" config is start=0, end=23 = every hour waking).
//
// SAFETY CONTRACT (#227/#450): the safety-tier senders — scheduled dose reminders
// and missed-dose escalation — MUST NEVER consult this. A possibly-critical
// medication signal must not be silenced by quiet hours (an escalation at 2am for a
// missed critical med is the feature working); only the non-safety EPISODE nudges
// (refill, preventive, milestone) call it. Do not wire this into a safety sender.
export function inWakingWindow(
  currentHour: number,
  startHour = WAKING_START_HOUR,
  endHour = WAKING_END_HOUR
): boolean {
  if (startHour <= endHour) {
    // Normal, same-day window: inclusive [start, end].
    return currentHour >= startHour && currentHour <= endHour;
  }
  // Wrapped window (crosses midnight): awake in [start, 23] OR [0, end].
  return currentHour >= startHour || currentHour <= endHour;
}
