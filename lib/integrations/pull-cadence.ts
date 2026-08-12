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
//     polled every connected pull source for every profile, so the second cadence
//     was silently pinned to the first — and a 1-minute tick would have meant ~1,440
//     Strava calls per profile per day, at or over typical app quotas.
//
// This module owns the second one. With it in place the tick rate and the poll rate
// are independent: a finer tick evaluates dues more often and polls sources exactly
// as often as they declare.
//
// THE GUARANTEE, stated precisely: at most ONE poll per (profile, source) per
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

// The cadence a pull source that declares none is polled at: hourly, which is what
// every source was polled at before the split. A new source therefore joins at
// the cadence the quota table in #2121 was measured against, and has to opt IN to
// anything finer.
export const DEFAULT_PULL_CADENCE_MINUTES = 60;

// The source's declared poll cadence in whole minutes, or the safe default. The ONE
// reader of the registry field — callers ask this rather than touching
// `pull.cadenceMinutes` — so "what cadence is this source on" is decided once. A
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

// The cadence window an instant falls in. Two instants in the same window are the
// same poll opportunity.
//
// `offsetMinutes` SHIFTS THE WINDOW BOUNDARY (#2567) — it does not add a wait inside
// the window, and that distinction is the whole safety argument. See
// `pullOffsetMinutes` below for why the offset exists; what matters here is what it
// costs. `floor((t − offset) / cadence)` is still a fixed-length bucket that changes
// exactly once per cadence, so the "at most one poll per (profile, source) per window"
// bound is untouched, there is still no tolerance to tune and no drift. All that moves
// is WHERE in the hour the boundary sits, and therefore which tick of the hour is the
// first one inside a fresh window.
//
// The alternative — "decline the window's first N ticks" — is what the issue proposed
// and it is unsafe at coarse tick rates: an operator running an hourly tick at :00
// against a 60-minute cadence would decline every tick it ever gets and the source
// would never poll at all. Shifting the boundary degrades to exactly today's behaviour
// there (one poll per hour, still at :00) and gives the intended stagger at the 5-minute
// tick the sidecar actually ships.
export function pullWindow(
  atMs: number,
  cadenceMinutes: number,
  offsetMinutes = 0
): number {
  return Math.floor(
    (atMs - offsetMinutes * 60_000) / (cadenceMinutes * 60_000)
  );
}

// How far from the epoch-aligned boundary an offset is allowed to place a window edge.
// The sidecar's tick is offered in divisors of 60 and ships at 5, so keeping the edge
// at least this far from :00 in BOTH directions means the first tick inside a shifted
// hourly window is never the top-of-hour tick at that rate. At coarser tick rates the
// offset simply has less to work with; it is never harmful.
export const MIN_POLL_OFFSET_MINUTES = 5;

// A small stable non-cryptographic hash (FNV-1a, 32-bit). Deterministic across
// processes and restarts, which `Math.random()` is not — a random offset per call
// would be untestable and would weaken the once-per-window reasoning to nothing.
function fnv1a(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// THE WINDOW OFFSET (#2567) — whole minutes, stable for a given seed and cadence.
//
// Weather & UV lost 209 of 289 runs in twelve days, every one of them a 503 on the
// hourly leg, and the cause was WHEN the poll fires rather than what it asks for.
// `pullWindow`'s buckets are epoch-aligned, so a 60-minute cadence fires on the first
// tick of each hour — at :00:00, with no jitter anywhere in the loop. Probing that
// instant from the affected host: 503s at T+0s, all rejected in ~0.40 s against a 15 s
// timeout (a load shedder answering before doing work), and 5/5 clean at T+10s and at
// every later offset. The stored ledger has the same signature: failures stamped 01–03
// seconds past the hour, successes 02–08. Strava is the control — same container, same
// egress, same epoch-aligned bucket, same instant, 348 runs at :00 and zero failures.
//
// So the fix is to stop aiming at the top of the hour. The offset is HASHED, not
// random: stable per install and per (profile, source), so it is assertable, and the
// once-per-window bound is preserved by construction because only the bucket's phase
// moves.
//
// It also de-herds ACROSS installs, which is the part a profile id alone cannot do:
// every allos in the world currently calls this keyless free API at :00:00. The caller
// seeds it with the instance's own `install_first_boot_at` for exactly that reason.
//
// Clamped into [MIN_POLL_OFFSET_MINUTES, cadence − MIN_POLL_OFFSET_MINUTES]; a cadence
// too short to hold that range takes no offset at all, because a fine cadence polls
// many times an hour anyway and has no top-of-hour herd to leave.
//
// ── NO RETRY, deliberately (#2567's second proposal, declined) ───────────────
//
// The issue offers "retry once on 5xx" as a backstop and calls it hygiene rather than
// the fix, on its own evidence: 70/70 requests succeeded from three network positions
// off-peak, and 5/5 succeeded at T+10s from the affected host. With the boundary
// moved, the poll no longer aims at the shed window, so a retry would be answering a
// question nobody has measured — while DOUBLING the outbound calls a keyless free API
// sees during a genuine outage, which is the herd behaviour this change exists to stop.
// It would also make a real outage look like a flap in a ledger that records one event
// per run, which is exactly the accounting defect #2567's own second half is fixing.
// If a retry is wanted later it has to be recorded, and that is its own change.
//
// ── #2385: how this would show itself wrong ──────────────────────────────────
//
// WORKING: weather sync events stop clustering at 01–03 seconds past the hour, and the
// failure runs stop being 503s. Both are already in `integration_sync_events` — the
// stamp and the error string — so this needs no new measurement.
// WRONG: a source that stops polling at all in some window (the once-per-window bound
// broken by the phase shift), or one whose stamps move but whose failure rate does not,
// which would mean the shed window was never the cause.
// DECEPTIVE SUCCESS: the weather success RATE rising on its own. It rises if the poll
// merely moved onto a boundary where the upstream serves stale or thinner data, and it
// rises if a run is now recorded as a success while half of it failed — which was true
// until this same change taught `runWeatherSync` to mark those runs partial. Read the
// rate beside `received` (381 = 360 hourly + 21 daily) and beside the partial standing,
// never alone.
export function pullOffsetMinutes(
  seed: string,
  cadenceMinutes: number
): number {
  const span = cadenceMinutes - 2 * MIN_POLL_OFFSET_MINUTES;
  if (span < 0) return 0;
  return MIN_POLL_OFFSET_MINUTES + (fnv1a(seed) % (span + 1));
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
  //                   a source off forever
  reason: "never-polled" | "window-open" | "same-window" | "unreadable";
}

// Whether a source may be polled now, given its last recorded ATTEMPT.
//
// LAST ATTEMPT, NOT LAST SUCCESS. The thing being rationed is the outbound API call,
// and a failed poll spent one. Keying on success would let a source that is failing
// — the exact case where a remote is rate-limiting or down — be retried on every
// single tick, which is the opposite of what a quota guard is for. A failure
// therefore waits out its window like a success does, which is also precisely the
// hourly retry behavior operators have today.
//
// A last attempt in the FUTURE (a container whose clock stepped backwards) compares
// as a DIFFERENT window rather than a later one, so it polls. The guard self-heals
// from clock skew instead of wedging for the length of the skew.
//
// `offsetMinutes` (#2567) defaults to 0 — an unshifted window, exactly the behaviour
// every existing bound here describes. Both sides of the comparison use the same
// offset, so the guarantee this function states is unchanged whatever it is set to.
export function shouldPollNow(input: {
  lastAttemptAt: string | null;
  now: Date;
  cadenceMinutes: number;
  offsetMinutes?: number;
}): PollDecision {
  if (input.lastAttemptAt == null)
    return { poll: true, reason: "never-polled" };
  const lastMs = parseSyncEventAt(input.lastAttemptAt);
  if (lastMs == null) return { poll: true, reason: "unreadable" };
  const cadence = input.cadenceMinutes;
  const offset = input.offsetMinutes ?? 0;
  return pullWindow(lastMs, cadence, offset) ===
    pullWindow(input.now.getTime(), cadence, offset)
    ? { poll: false, reason: "same-window" }
    : { poll: true, reason: "window-open" };
}
