// PURE poll-cadence decision for scheduled pulls (#2121 step 1). No DB, no network,
// so it lives in the pure unit tier alongside its sibling registry readers
// staleness.ts and auth-failure.ts. The DB half — reading the last attempt and
// running the loop — is lib/integrations/pull-tick.ts.
//
// THE TWO CADENCES THE TICK USED TO CONFLATE.
//
//   • "How often do we evaluate what is DUE to send." Bounded only by the tick's own
//     process boot (~0.5 s). It is allowed to go to minutes, and finer is strictly
//     better for escalation latency and workout-finish backstops.
//   • "How often do we call someone ELSE'S API." Bounded by their quota. Every tick
//     polled every connected pull provider for every profile, so the second cadence
//     was silently pinned to the first — and a 1-minute tick would have meant ~1,440
//     Strava calls per profile per day, at or over typical app quotas.
//
// This module owns the second one. With it in place the tick rate and the poll rate
// are independent: a finer tick evaluates dues more often and polls providers exactly
// as often as they declare.
//
// THE GUARANTEE, stated precisely: at most ONE poll per (profile, provider) per
// cadence WINDOW. Windows are fixed epoch-aligned buckets of `cadenceMinutes`, not a
// "minutes since last poll" comparison — that distinction is the whole design:
//
//   • Elapsed-since needs a slack tolerance, because an hourly cron firing at
//     09:00:01 and 10:00:00 measures 59m59s and would skip the second poll forever.
//     Any tolerance you pick then drifts the effective cadence EARLIER at fine tick
//     rates (a 5-minute slack turns a 60-minute cadence into 55).
//   • Buckets have no drift and no tolerance to tune. `floor(t / cadence)` changes
//     exactly once per window, so the count per window is exactly the bound above,
//     and today's hourly tick keeps polling on every tick because each tick lands in
//     a new hour bucket. Behavior at hourly grain is unchanged.
//
// The cost of buckets is a boundary case: a poll at 09:59 and another at 10:00 are
// one minute apart. That is bounded (still one per window) and is exactly what an
// hourly cron does today, so it changes nothing an operator has not already seen.
//
// A cadence that does not divide the hour (say 45) still bounds the rate; its grid
// simply is not hour-aligned. Nothing here requires alignment.

import type { IntegrationDef } from "../types";

// The cadence a pull provider that declares none is polled at: hourly, which is what
// every provider was polled at before the split. A new provider therefore joins at
// the cadence the quota table in #2121 was measured against, and has to opt IN to
// anything finer.
export const DEFAULT_PULL_CADENCE_MINUTES = 60;

// The provider's declared poll cadence in whole minutes, or the safe default. The ONE
// reader of the registry field — callers ask this rather than touching
// `pull.cadenceMinutes` — so "what cadence is this provider on" is decided once. A
// non-positive or non-integer declaration is ignored rather than obeyed: a cadence of
// 0 would mean "poll on every tick", which is the very thing the guard exists to
// prevent, and silently honouring it would make a registry typo a quota incident.
export function pullCadenceMinutes(def: IntegrationDef | undefined): number {
  const declared = def?.pull?.cadenceMinutes;
  return typeof declared === "number" &&
    Number.isInteger(declared) &&
    declared > 0
    ? declared
    : DEFAULT_PULL_CADENCE_MINUTES;
}

// The epoch-aligned cadence window an instant falls in. Two instants in the same
// window are the same poll opportunity.
export function pullWindow(atMs: number, cadenceMinutes: number): number {
  return Math.floor(atMs / (cadenceMinutes * 60_000));
}

// Parse a stored sync-event timestamp to epoch ms, or null when it is unusable.
//
// Sync-event `at` values are written by SQLite's `datetime('now')` —
// "YYYY-MM-DD HH:MM:SS", UTC, with no zone marker — or, from a JS writer, as an ISO
// instant. The bare-space form is NOT valid ISO 8601 and `new Date()` parses it in
// LOCAL time, which on a container running TZ=America/Chicago would read every stamp
// as five hours late and hold every poll back by that much. So the space form is
// normalized to an explicit UTC instant before parsing.
export function parseSyncEventAt(at: string | null | undefined): number | null {
  if (!at) return null;
  const iso = at.includes("T") ? at : `${at.replace(" ", "T")}Z`;
  const ms = new Date(iso).getTime();
  return Number.isNaN(ms) ? null : ms;
}

export interface PollDecision {
  poll: boolean;
  // Why, for the tick's log line and for tests that want to assert the branch rather
  // than only the boolean.
  //   never-polled  — no recorded attempt at all; the first poll is always allowed
  //   window-open   — the last attempt was in an earlier (or later) cadence window
  //   same-window   — already polled this window; this is the skip that bounds quota
  //   unreadable    — a stamp we could not parse; polls, so a bad row can never wedge
  //                   a provider off forever
  reason: "never-polled" | "window-open" | "same-window" | "unreadable";
}

// Whether a provider may be polled now, given its last recorded ATTEMPT.
//
// LAST ATTEMPT, NOT LAST SUCCESS. The thing being rationed is the outbound API call,
// and a failed poll spent one. Keying on success would let a provider that is failing
// — the exact case where a remote is rate-limiting or down — be retried on every
// single tick, which is the opposite of what a quota guard is for. A failure
// therefore waits out its window like a success does, which is also precisely the
// hourly retry behavior operators have today.
//
// A last attempt in the FUTURE (a container whose clock stepped backwards) compares
// as a DIFFERENT window rather than a later one, so it polls. The guard self-heals
// from clock skew instead of wedging for the length of the skew.
export function shouldPollNow(input: {
  lastAttemptAt: string | null;
  now: Date;
  cadenceMinutes: number;
}): PollDecision {
  if (input.lastAttemptAt == null) return { poll: true, reason: "never-polled" };
  const lastMs = parseSyncEventAt(input.lastAttemptAt);
  if (lastMs == null) return { poll: true, reason: "unreadable" };
  const cadence = input.cadenceMinutes;
  return pullWindow(lastMs, cadence) === pullWindow(input.now.getTime(), cadence)
    ? { poll: false, reason: "same-window" }
    : { poll: true, reason: "window-open" };
}
