// Pure PRN redose-window decision (issue #798). No DB/network — the notify tick
// gathers the inputs (latest administration, today's count, the confirmed per-item
// interval/max) and this decides whether the one-shot notice fires. Unit-tested in
// lib/__tests__/prn-redose.test.ts.
//
// ONE-SHOT, ADMINISTRATION-ARMED (issue #798):
//   • The timer is armed by the LATEST logged administration. The notice fires ONCE
//     when the minimum interval elapses since that administration, then is silent —
//     the marker is keyed by the administration id (the notify_last_* discipline).
//   • It RE-ARMS only when a NEWER administration is logged (a new id ⇒ the marker no
//     longer matches ⇒ eligible again).
//   • It is SUPPRESSED once the day's count reaches the confirmed max (no "you can
//     take more" past the label max).
//
// The opt-in + confirmed-fields gate lives in the gather query (getRedoseNoticeItems
// only returns opted-in items with BOTH interval and max confirmed), so this function
// assumes those are valid positives and focuses purely on the timing/one-shot logic.
//
// QUIET-HOURS EXCEPTION (deliberate): this decision has NO waking-window input. The
// notice is armed only by an actual administration and is opt-in per item, and 3am is
// exactly the fever case — so the tick calls this UNCONDITIONALLY, unlike the episode
// nudges. Documented in docs/internals/notifications.md.

// ---- Over-max care finding (#798, #148 UL-warning shape applied to count/day) ----

// The findings-bus namespace for the "over the confirmed daily max" care finding. A
// per-item, count-per-day analogue of the dietary-limit (UL) warning: when today's
// administrations EXCEED the user's confirmed max_daily_count, surface a dismissible
// care-tier finding (Upcoming + the dashboard attention hero). Registered on the
// intake-surface dismiss guard so a dismiss silences it like any other finding.
export const PRN_MAX_PREFIX = "prn-max:";

// The stable dedupe/suppression key for an over-max finding: `prn-max:<itemId>`, keyed
// on the AUTOINCREMENT item id (never recycles, #203). A new day's count resets the
// UNDERLYING condition, but the key stays stable so a same-episode dismiss holds.
export function prnMaxSignalKey(itemId: number): string {
  return `${PRN_MAX_PREFIX}${itemId}`;
}

export interface RedoseWindowInput {
  // Confirmed per-item numbers (both > 0; guaranteed by the gather query).
  minIntervalHours: number;
  maxDailyCount: number;
  // The latest logged administration for the item (arms the one-shot). null ⇒ nothing
  // logged yet ⇒ not armed.
  latestAdministrationId: number | null;
  latestGivenAt: Date | null;
  // Today's administration count in the profile's timezone (drives "N of M" + max
  // suppression).
  countToday: number;
  now: Date;
  // The administration id the marker was last set to (notify_last_redose_<itemId>),
  // or null when never notified. Equal to latestAdministrationId ⇒ already fired for
  // THIS administration ⇒ one-shot done.
  notifiedAdministrationId: number | null;
}

export type RedoseDecision =
  | {
      kind: "fire";
      administrationId: number;
      countToday: number;
      maxDailyCount: number;
      sinceHours: number;
      lastGivenAt: Date;
    }
  | { kind: "not-armed" } // no administration to arm the timer
  | { kind: "already-notified" } // one-shot already fired for the latest administration
  | { kind: "not-yet"; opensInHours: number } // interval hasn't elapsed
  | { kind: "suppressed-max" }; // day's count has reached the confirmed max

// Hours elapsed between two instants (may be fractional).
function hoursBetween(from: Date, to: Date): number {
  return (to.getTime() - from.getTime()) / 3_600_000;
}

export function redoseNoticeDecision(input: RedoseWindowInput): RedoseDecision {
  const { latestAdministrationId, latestGivenAt } = input;
  // Not armed: nothing logged, so there's no window to open.
  if (latestAdministrationId == null || latestGivenAt == null) {
    return { kind: "not-armed" };
  }
  // One-shot: we already notified for THIS exact administration. Only a newer
  // administration (a different id) re-arms it.
  if (input.notifiedAdministrationId === latestAdministrationId) {
    return { kind: "already-notified" };
  }
  const elapsed = hoursBetween(latestGivenAt, input.now);
  if (elapsed < input.minIntervalHours) {
    return { kind: "not-yet", opensInHours: input.minIntervalHours - elapsed };
  }
  // Window is open. Suppress at/over the confirmed daily max (label ceiling) — no
  // marker is written, so a later administration (new id) re-evaluates cleanly.
  if (input.countToday >= input.maxDailyCount) {
    return { kind: "suppressed-max" };
  }
  return {
    kind: "fire",
    administrationId: latestAdministrationId,
    countToday: input.countToday,
    maxDailyCount: input.maxDailyCount,
    sinceHours: elapsed,
    lastGivenAt: latestGivenAt,
  };
}

// A marker-AGNOSTIC redose status for the always-on SURFACING paths (the med card,
// the dashboard PRN widget) — unlike redoseNoticeDecision, this ignores the one-shot
// notification marker, because a card should always show the current window state, not
// go silent after the notice fired. Returns null when nothing has been logged yet
// (no window to describe). The interval/max are the item's confirmed numbers.
export interface RedoseStatus {
  open: boolean; // the minimum interval has elapsed since the last administration
  atMax: boolean; // today's count has reached the confirmed daily max
  countToday: number;
  maxDailyCount: number;
  sinceHours: number; // hours since the last administration
  opensInHours: number; // hours until the window opens (0 when already open)
}

export function redoseWindowStatus(input: {
  minIntervalHours: number;
  maxDailyCount: number;
  latestGivenAt: Date | null;
  countToday: number;
  now: Date;
}): RedoseStatus | null {
  if (!input.latestGivenAt) return null;
  const elapsed = hoursBetween(input.latestGivenAt, input.now);
  const open = elapsed >= input.minIntervalHours;
  return {
    open,
    atMax: input.countToday >= input.maxDailyCount,
    countToday: input.countToday,
    maxDailyCount: input.maxDailyCount,
    sinceHours: elapsed,
    opensInHours: open ? 0 : input.minIntervalHours - elapsed,
  };
}
