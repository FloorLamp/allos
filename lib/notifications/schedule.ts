// Pure scheduling helpers for the notify tick (no DB/network), so they can be
// unit-tested.
//
// SLOT TIMES ARE MINUTES OF DAY (#2121). Every stored notification slot is a
// minute-of-day (0–1439), persisted as "HH:MM", and "now" is the profile-local
// minute-of-day from ONE derivation (minuteOfDayInTz, lib/date.ts). The waking
// window's BOUNDS and the global backup hour deliberately stay hour-typed — see
// inWakingWindow and lib/backup-rotation.ts for those two explicit decisions.

export const MINUTES_PER_DAY = 1440;

// The tick cadence assumed when nothing has been observed: one tick per hour, the
// host-crontab shape and the pre-#2121 sidecar. slotAttempt degrades gracefully
// under it — a sub-hourly slot fires at the next hourly tick, up to 59 minutes
// late — which is what keeps an operator on `0 * * * *` working unchanged.
export const DEFAULT_TICK_MINUTES = 60;

// How long after the first attempt the one retry attempt runs. An hour, exactly as
// it has always been — see the retry-budget block at slotAttempt.
export const SLOT_RETRY_DELAY_MIN = 60;

// Clamp a claimed/observed tick interval to what the attempt math may trust:
// integers in [1, DEFAULT_TICK_MINUTES]. Anything unknown or slower than hourly
// reads as hourly — a scheduler that fell behind (downtime, a wedged loop) must
// not widen the due window past today's behavior and start delivering hours-late
// reminders.
export function clampTickMinutes(raw: number | null | undefined): number {
  if (raw == null || !Number.isFinite(raw)) return DEFAULT_TICK_MINUTES;
  // Round, don't ceil: a 15-minute cadence measured as 15.02 must stay a
  // 15-minute band — a 16-minute band would let a slot sitting exactly on a tick
  // boundary match two consecutive ticks as "first".
  const n = Math.round(raw);
  if (n < 1) return DEFAULT_TICK_MINUTES;
  return Math.min(n, DEFAULT_TICK_MINUTES);
}

// The observed tick interval in minutes, from the previous tick's epoch ms and
// now. This is what the tick feeds slotAttempt as `tickMinutes`, and what the
// Settings warning compares sub-hourly slot times against: the scheduler's REAL
// cadence, not a declared one, so a docker sidecar at 15 minutes and a host
// crontab at 60 each get the bands their ticks actually land in. First tick ever
// (no watermark) reads as hourly — the safe, widest-band assumption.
export function observedTickMinutes(
  prevMs: number | null,
  nowMs: number
): number {
  if (prevMs == null || !Number.isFinite(prevMs) || nowMs <= prevMs) {
    return DEFAULT_TICK_MINUTES;
  }
  return clampTickMinutes((nowMs - prevMs) / 60000);
}

// ── THE RETRY BUDGET IS DECIDED: TWO ATTEMPTS, AN HOUR APART, AT EVERY TICK RATE ──
//
// (#2121 item 3 — the decision the pull-cadence wave left written out here.) A send
// marker is written only on `delivered`, so every tick on which a slot reads "due"
// re-attempts a failing send. Under a naive minute-grain window ([slot, slot+2h) as
// a membership test) the attempt count would have been the window divided by the
// tick rate — 8 attempts at 15-minute ticks, 120 at 1-minute — silently, with
// failure-log volume and channel hammering scaling with a scheduler constant.
//
// Instead the window is two discrete ATTEMPT BANDS, each one tick wide:
//
//     first: offset ∈ [0, tick)            — the first tick at/after the slot time
//     retry: offset ∈ [60, 60 + tick)      — the first tick an hour later
//
// where offset = nowMinute − slotMinute, never negative and never wrapped. A slot is
// "due" only on a tick that lands in a band, so a FAILING send is attempted exactly
// twice a day, one hour apart — precisely the budget the hourly tick has always had,
// now invariant under the tick rate. This is the stateless "back off" option: no
// attempt counter, so nothing new to mint, key, sweep or declare in
// SEND_MARKER_REGISTRY. The hour spacing is also the compromise the two channel
// futures pull toward from opposite ends — #1855's email channel wants retries that
// outlive an SMTP greylist (an hour does), a push service returning 429 wants not to
// be hammered (twice a day is not hammering). If a channel ever needs a different
// budget, SLOT_RETRY_DELAY_MIN and the band count are the one place to change it.
//
// WHAT THE BANDS PRESERVE from the old [slotHour, slotHour+1] hour-equality window:
//   • At the hourly tick the behavior is bit-identical: ticks land on :00, so the
//     first band catches hour == slotHour (any slot minute in that hour) and the
//     retry band hour == slotHour+1.
//   • DST spring-forward: a slot inside the skipped hour has no tick in its first
//     band (those local minutes never occur), and the first tick after the gap —
//     local offset ≤ 60 + tick — lands in the retry band. The slot still fires,
//     exactly as "or the next hour" recovered it before.
//   • MIDNIGHT DOES NOT WRAP, same rule and same reason as always: a next-day tick
//     has a small minute-of-day, its offset goes negative, and the slot is not due.
//     Hour 0 is the next calendar day, where the per-day dedup key is fresh — a
//     wrapped slot-23:xx retry would fire at midnight, get marked for the NEW day,
//     and suppress that day's real send, permanently drifting the slot. DST
//     transitions never occur at midnight, so the wrap isn't needed for the
//     spring-forward case either. The cost is real and documented: a slot within
//     the last hour of the day has no retry band (23:00 keeps its single attempt,
//     as it always had), and a slot AFTER the day's last tick (e.g. 23:50 under
//     hourly ticks) never fires at all — which is one of the two conditions the
//     sub-hourly Settings warning (subHourlySlotsAtRisk) exists to surface.
//   • Nothing user-visible repeats: the per-day marker still admits exactly one
//     delivered send per slot per day (the #2121 non-negotiable), on every tick
//     rate. On the DST fall-back day a repeated local hour can re-open a band, as
//     it always could; the per-day marker absorbs it.
//
// The #2102 digest deferral rides the bands by name: declining is legal only on a
// "first" tick, which leaves the "retry" tick to send unconditionally — the same
// once-and-only-once structure it had at hour grain.
export type SlotAttempt = "first" | "retry";

// Which attempt band this tick is in for a slot, or null when the slot is not due.
// `slotMinute` and `nowMinute` are profile-local minutes of day; `tickMinutes` is
// the (observed, clamped) scheduler cadence.
export function slotAttempt(
  slotMinute: number,
  nowMinute: number,
  tickMinutes: number = DEFAULT_TICK_MINUTES
): SlotAttempt | null {
  const tick = clampTickMinutes(tickMinutes);
  const offset = nowMinute - slotMinute;
  if (offset >= 0 && offset < tick) return "first";
  if (
    offset >= SLOT_RETRY_DELAY_MIN &&
    offset < SLOT_RETRY_DELAY_MIN + tick &&
    // The retry band exists only same-day; nowMinute < MINUTES_PER_DAY always
    // holds, so this is implied — kept explicit for the reader.
    nowMinute < MINUTES_PER_DAY
  ) {
    return "retry";
  }
  return null;
}

// Whether a slot scheduled for `slotMinute` is due at the current profile-local
// minute — i.e. this tick lands in one of the slot's two attempt bands.
export function slotDue(
  slotMinute: number,
  nowMinute: number,
  tickMinutes: number = DEFAULT_TICK_MINUTES
): boolean {
  return slotAttempt(slotMinute, nowMinute, tickMinutes) !== null;
}

// The sub-hourly slot times the observed tick cadence cannot land on time —
// "cannot honour" made checkable (#2121 constraint 4). A slot is at risk when the
// scheduler's real cadence would deliver it more than `toleranceMin` late (an
// hourly tick fires a 07:30 slot at 08:00), or when it sits past the day's last
// tick and would never fire at all (23:50 under hourly ticks — see the no-wrap
// rule above). Hour-aligned slots are never at risk: every supported cadence
// lands on :00. Returns the offending minutes so the caller can name them.
export function subHourlySlotsAtRisk(
  slotMinutes: readonly (number | null)[],
  observedTickMin: number,
  toleranceMin = 5
): number[] {
  const tick = clampTickMinutes(observedTickMin);
  return slotMinutes.filter((m): m is number => {
    if (m == null || m % 60 === 0) return false;
    // Worst-case lateness of the first attempt: the slot just misses a tick and
    // waits out the full interval (ticks are epoch-aligned, minute-resolution).
    if (tick - 1 > toleranceMin) return true;
    // Past the day's final tick there is no band left to fire in.
    const lastTick = MINUTES_PER_DAY - (MINUTES_PER_DAY % tick || tick);
    return m > lastTick;
  });
}

// The humane waking window (profile-local hours) the non-time-critical EPISODE
// nudges are held to (issue #378). Unlike the dose/digest/workout/recap slots,
// the refill, preventive, and milestone nudges have no slot of their own — they
// are evaluated on every tick and would otherwise fire the instant an episode
// becomes due: at the local-midnight date rollover (a preventive rule flips
// "due"), or 1-3am after a late Strava/Oura sync or a late button-tap that
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

// Default profile-local minutes of day for scheduled intake reminders. Keep this
// in the pure scheduling layer so settings and onboarding restore the same
// defaults. (08:00 / 13:00 / 20:00 / 22:00 — the same clock times the hour-typed
// defaults always meant.)
export const DEFAULT_INTAKE_REMINDER_MINUTES = {
  Morning: 8 * 60,
  Midday: 13 * 60,
  Evening: 20 * 60,
  Bedtime: 22 * 60,
} as const;

// The PreWorkout pseudo-slot minute (issue #1154 Fix A): fire the tick's
// pre-workout reminder one hour BEFORE the inferred training time, so the send
// lands ahead of the session (inferred 18:00 → the 17:00 slot; at hourly ticks
// that is ~30–60 min ahead, at finer ticks closer to the full hour). Wraps at
// midnight defensively (an inferred 00:xx → 23:xx) — slotAttempt's no-wrap retry
// rule still applies to the resulting minute.
export function preWorkoutSlotMinute(inferredWorkoutMinute: number): number {
  return (inferredWorkoutMinute + MINUTES_PER_DAY - 60) % MINUTES_PER_DAY;
}

// The auto-time sentinel stored in profile_settings (issue #1117) for a slot that
// should follow the profile's wake time. It is a KV VALUE, distinct from the three
// states the raw string already encodes — absent, "" (off), a "HH:MM" time (manual)
// — so "auto" is a fourth, explicit state the user chose. Kept here in the pure
// scheduling layer so the reader (getNotifySchedule) and the settings form agree.
export const AUTO_TIME = "auto";

// Format a minute-of-day as the canonical stored/form value ("HH:MM", 24h,
// zero-padded). The one serializer parseNotifyTime round-trips.
export function formatNotifyTime(minute: number): string {
  const m = ((Math.round(minute) % MINUTES_PER_DAY) + MINUTES_PER_DAY) %
    MINUTES_PER_DAY;
  const h = Math.floor(m / 60);
  return `${String(h).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

const HHMM_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

// Resolve a stored notify-time value to a concrete minute-of-day (0–1439) or null
// (off), mapping the wake-aware states (issue #1117). This is the ONE place the raw
// states collapse, so the read side can't drift from the write side:
//   • undefined (absent, never configured) → `absentFallback`
//   • ""        (explicitly off)           → null
//   • "auto"    (follow wake time)         → `autoValue`
//   • "HH:MM"   (a specific time the user picked, manual — always wins)
//   • "N" 0-23  (LEGACY integer hour, pre-migration-158 or written by an old
//                process during a deploy overlap) → that hour's first minute, so
//                a stored 7 keeps meaning 07:00 through the format change
//   • anything else (corrupt)              → `absentFallback`
// `autoValue` defaults to `absentFallback`, so a slot whose default IS the
// wake-derived time needs to pass it only once. A manual time is never overwritten
// by seeding — that's "seed the default, never move a time you've set."
export function parseNotifyTime(
  raw: string | undefined,
  absentFallback: number | null,
  autoValue: number | null = absentFallback
): number | null {
  if (raw === undefined) return absentFallback; // unset → default
  if (raw === "") return null; // explicitly off
  if (raw === AUTO_TIME) return autoValue; // follow wake time
  const m = HHMM_RE.exec(raw);
  if (m) return Number(m[1]) * 60 + Number(m[2]);
  const n = Number(raw);
  if (Number.isInteger(n) && n >= 0 && n <= 23 && String(n) === raw.trim()) {
    return n * 60; // legacy integer hour
  }
  return absentFallback;
}

// Resolve a stored notify-HOUR value to a concrete 0-23 hour or null (off). The
// surviving hour-typed settings — the waking-window bounds (#450) and the global
// backup hour — still parse through this; the slot times moved to parseNotifyTime
// above. Same state collapse, hour-valued:
//   • undefined → `absentFallback`; "" → null; "auto" → `autoValue`;
//   • "N" 0-23 → that hour; anything else → `absentFallback`.
export function parseNotifyHour(
  raw: string | undefined,
  absentFallback: number | null,
  autoValue: number | null = absentFallback
): number | null {
  if (raw === undefined) return absentFallback; // unset → default
  if (raw === "") return null; // explicitly off
  if (raw === AUTO_TIME) return autoValue; // follow wake time
  const n = Number(raw);
  return Number.isInteger(n) && n >= 0 && n <= 23 ? n : absentFallback;
}

// Whether the given profile-local minute-of-day is inside the waking window (issue
// #378, made per-profile in #450). THE BOUNDS STAY HOUR-TYPED ON PURPOSE (#2121):
// quiet hours are a coarse humane band, not a schedule — nobody needs nudges held
// until 8:07 — so the stored keys (`notify_waking_start`/`_end`) keep their 0-23
// meaning and only the CURRENT TIME moved to minute grain. Inclusive on both
// bounds, hour-wise: waking runs [startHour:00, endHour:59]. A window that WRAPS
// past midnight (startHour > endHour, e.g. a night-shift 20→8 waking window) is
// supported: the minute is waking if it's at/after the start OR at/before the end.
// A same start/end is a literal one-hour window (an unlikely edge; the widest
// "no quiet hours" config is start=0, end=23 = every minute waking).
//
// SAFETY CONTRACT (#227/#450): the safety-tier senders — scheduled dose reminders
// and missed-dose escalation — MUST NEVER consult this. A possibly-critical
// medication signal must not be silenced by quiet hours (an escalation at 2am for a
// missed critical med is the feature working); only the non-safety EPISODE nudges
// (refill, preventive, milestone) call it. Do not wire this into a safety sender.
export function inWakingWindow(
  currentMinuteOfDay: number,
  startHour = WAKING_START_HOUR,
  endHour = WAKING_END_HOUR
): boolean {
  const start = startHour * 60;
  const end = endHour * 60 + 59;
  if (startHour <= endHour) {
    // Normal, same-day window: inclusive [start:00, end:59].
    return currentMinuteOfDay >= start && currentMinuteOfDay <= end;
  }
  // Wrapped window (crosses midnight): awake in [start:00, 23:59] OR [00:00, end:59].
  return currentMinuteOfDay >= start || currentMinuteOfDay <= end;
}
