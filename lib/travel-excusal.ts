// Which of a profile's dose slots a timezone switch EXCUSED (issue #3263) — the
// profile-scoped resolver that joins the pure rules (lib/travel-timezone.ts) to the
// two consumers that must agree: the adherence denominator and the reminder tick.
//
// ONE NUMBER, ONE RULE. A dose's slot minute here is the SAME minute the tick fires
// that slot at — the profile's configured reminder time for the dose's send window,
// falling back to the shipped default when that window is switched off. That is what
// makes "out of the denominator" and "sends nothing" two readings of one fact rather
// than two rules that can drift: if the app decides a slot was impossible, it must
// neither count it nor chase it.
//
// A dose whose bucket is "Anytime" is NEVER excused. Its window is the whole day, so
// a stretch of skipped wall clock does not make it impossible — only late. Excusing
// it would be the same error in the other direction: a dose quietly dropped from the
// denominator that the person could still have taken and was never asked about.

import { timeBucket, type TimeBucket } from "./intake-schedule";
import {
  bucketWindow,
  type ReminderWindow,
} from "./notifications/intake-format";
import { DEFAULT_INTAKE_REMINDER_MINUTES } from "./notifications/schedule";
import { getNotifySchedule } from "./settings/notifications";
import { getTimezone } from "./settings/display";
import { getTravelSwitches } from "./settings/travel";
import {
  connectedTimezoneSwitchHistory,
  isExcusedSlot,
  resolveSwitchHistory,
  zoneInChainAt,
  type GatedSwitchHistory,
  type ProfileDayZone,
} from "./travel-timezone";

// The profile-local minute a reminder window fires at: the configured time, or the
// shipped default when the window is off. A window switched off still HAS a nominal
// time of day — turning reminders off does not move when the dose is meant to be
// taken — so the denominator keeps judging it there.
export function windowSlotMinute(
  window: ReminderWindow,
  configured: number | null | undefined
): number {
  return configured ?? DEFAULT_INTAKE_REMINDER_MINUTES[window];
}

// Whether a dose in `bucket` was excused on profile-local day `date`.
export function isDoseSlotExcused(
  history: GatedSwitchHistory,
  slotMinutes: Record<ReminderWindow, number | null>,
  bucket: TimeBucket,
  date: string
): boolean {
  if (bucket === "Anytime") return false;
  const window = bucketWindow(bucket);
  return isExcusedSlot(
    history,
    date,
    windowSlotMinute(window, slotMinutes[window])
  );
}

// A dose-level excusal predicate for one profile, resolved once. `time_of_day` is
// free text on the dose row (`timeBucket` is the reader for it), so the predicate
// takes the raw column and buckets it here — a caller never has to know that.
export type DoseExcusalResolver = (
  timeOfDay: string | null,
  date: string
) => boolean;

export function travelExcusalResolver(profileId: number): DoseExcusalResolver {
  // Gated AND resolved once (#5010): every switch's two local positions are computed
  // here rather than per dose slot, which is what the strip was paying `Intl` for.
  const history = resolveSwitchHistory(
    getTravelSwitches(profileId),
    getTimezone(profileId)
  );
  // The overwhelmingly common case: nobody has travelled, so nothing is excused and
  // neither the schedule read nor the per-day work is worth doing.
  if (history.length === 0) return () => false;
  const slotMinutes = getNotifySchedule(profileId).supplementMinutes;
  return (timeOfDay, date) =>
    isDoseSlotExcused(history, slotMinutes, timeBucket(timeOfDay), date);
}

// The profile's day zone for DATED reads (#4025) — the sibling of the excusal
// resolver above, built from the same recorded history and with the same fail-open
// posture. A profile that has never switched gets its plain zone string back, so the
// common path stays a bare `dateStrInTz` with nothing extra to go wrong.
export function profileDayZone(profileId: number): ProfileDayZone {
  const tz = getTimezone(profileId);
  // The chain is built ONCE and closed over, not rebuilt per stamp: validating a full
  // 24-switch history costs 48 uncached Intl.DateTimeFormat constructions, and a strip
  // resolves one per creation stamp of every dose it draws (#4030).
  const chain = connectedTimezoneSwitchHistory(
    getTravelSwitches(profileId),
    tz
  );
  if (chain.length === 0) return tz;
  return (at) => zoneInChainAt(chain, tz, at);
}

// The SLOT-level twin, for the notify tick: was this window's own send excused on
// this profile-local day? Same switches, same minute, so a slot the denominator
// forgives is a slot the tick stays silent about.
export function isReminderSlotExcused(
  history: GatedSwitchHistory,
  date: string,
  slotMinute: number
): boolean {
  return isExcusedSlot(history, date, slotMinute);
}
