// Delayed post-workout dispatch queue (issue #1154 §B). The moment a workout
// COMPLETION lands — the live Finish action setting end_time, a retroactive
// completed log, or an integration sync landing a session with an end time today
// — the write path arms a short (~60s) timer that runs the SAME
// runPostWorkoutForActivity core the hourly tick's flagship uses (#221: one
// dispatch core, never a second implementation), so the post-workout dose
// reminder lands moments after completion instead of up to an hour later.
//
// Why ~60s and not instant: let the session settle — a mis-tapped or
// immediately-undone finish never fires (the core re-verifies the row is still
// completed at fire time), last-second edits (an added set, a corrected end
// time) land before the dose set + recap are computed, and a
// finish→unfinish→re-finish within the window RE-ARMS the one timer keyed on
// the activity id (single send after it settles), never two.
//
// The timer is deliberately best-effort and NON-BLOCKING: the arming write path
// returns immediately (never awaiting Telegram/Push/HA latency), and a process
// restart in the window simply drops the timer — which is exactly why the
// hourly tick's presence-based flagship remains the MANDATORY backstop, and why
// both paths share the stamp-on-delivery one-shot marker
// (notify_last_post_workout_<activityId>): whoever delivers first stamps it,
// the other skips. The notify-tick process exits after each run, so the tick
// calls flushPostWorkoutDispatches() before exiting — a dispatch armed by a
// sync inside the tick runs immediately rather than dying with the process.
//
// Quiet hours: deliberately NOT consulted (a post-completion send is a direct
// response to an action the user just took — finishing at 2am means they're
// demonstrably awake), matching the flagship's existing not-waking-gated stance.
//
// The runner is injected (tests) and defaults to a dynamic import of the heavy
// dispatch core, so light write paths (Server Actions, sync runners) arming a
// timer don't statically pull the whole notification stack.
//
// ── Why the runs are SERIALIZED per profile (#3021) ─────────────────────────
//
// The dispatch's duplicate awareness (#2570) is a read-then-act check: it asks
// whether a row a high-confidence detection calls the same session has already
// been announced, and the marker it reads is stamped only AFTER a successful
// delivery — deliberately, so a failed send is re-delivered by the tick
// backstop. Between that read and that stamp sit a message build and a network
// round trip.
//
// One Health Connect push landing TWO rows of one bike ride armed two timers
// microseconds apart. Both expired in the same tick, both guards read the twin's
// marker before either had delivered, and one ride produced two recaps a minute
// apart. #2570's own two sends were fifteen minutes apart, from two pushes, and
// that gap is the only reason a read-then-act guard held there.
//
// So the runs THIS QUEUE arms for one profile go through a promise chain and
// cannot interleave with each other — the same serialization
// flushPostWorkoutDispatches() already gives the tick path (`for … await
// e.run()`), now applied to the timer path an ingest arms in the web process.
// Different profiles keep their own chains: they share no marker and have no
// reason to wait on each other.
//
// THE RESIDUAL, stated rather than implied away (#3021 asked for this). The chain
// serializes what goes THROUGH it, and two callers do not:
//
//   - Another process. A web-process timer and the notify tick are separate
//     processes and nothing here spans them.
//   - The dispatch core called DIRECTLY, in this same process.
//     `runPostWorkoutForActivity` is the shared core, and the tick's flagship
//     (`runPostWorkoutFinish` → scripts/notify.ts) calls it without the queue —
//     inside the same tickProfile that ran `syncIntegrations`, which is what arms
//     these timers. A dispatch held on a slow send while the flagship runs the
//     twin row is two sends with both markers stamped, in one process. It is
//     narrower than the same-push race (it needs the two paths to overlap, not
//     just two rows in one push) and it is not new, but it is not closed.
//
// So the documented at-least-once posture stands: a rare duplicate is still
// possible, and closing it needs a DB-level claim over the marker, which is out
// of scope. What is gone is the SAME-PUSH race, which was not rare: it was every
// multi-row ingest.
//
// The alternative — stamping the marker before sending — was rejected: it would
// close the window and break the property the run() comment below depends on
// (stamp only on successful delivery), trading a duplicate contact for a lost
// one.
//
// ── Why a queued run is BOUNDED ────────────────────────────────────────────
//
// Serializing makes one run's latency the next run's delay. `dispatch()` itself
// is bounded now — the shared NOTIFICATION_DISPATCH_TIMEOUT_MS whole-dispatch
// deadline (#3057, ./dispatch-deadline) resolves the fan-out even when a channel
// never settles — so the delivery leg of a queued run has a ceiling of its own.
// The queue still keeps a defensive whole-TASK guard, because a run is more than
// its dispatch: the dynamic import of the heavy core, the completed-row
// re-verification, and the message build all sit outside the dispatch deadline,
// and any of them hanging would still stall the profile's chain and the notify
// tick's exit drain — silence, which is the harm this tier exists to prevent.
//
// The guard is DERIVED from the shared deadline, strictly greater (never a
// second competing 120s literal racing it at the same instant): a dispatch the
// shared deadline is still bounding always resolves before this guard fires, so
// the guard only ever trips on non-dispatch work that is genuinely stuck. When
// it does, the slot is released, the chain moves on, and the abandoned run is
// left to finish or not: if it never delivered it never stamped, so the hourly
// tick's backstop re-delivers; if it delivers late it stamped, and the marker
// keeps the backstop quiet. Losing the ordering guarantee for a run that has
// already hung this long is the right trade — the alternative is that
// everything after it is lost.

import { createLogger, safeString } from "../log";
import { clockOverride } from "../clock";
import { NOTIFICATION_DISPATCH_TIMEOUT_MS } from "./dispatch-deadline";

const log = createLogger("notify");

export const POST_WORKOUT_DISPATCH_DELAY_MS = 60_000;

// How long ONE queued run may hold the chain before the queue gives up on it
// (see the header). Derived from the shared whole-dispatch deadline (#3057),
// STRICTLY greater: dispatch() itself resolves at NOTIFICATION_DISPATCH_TIMEOUT_MS
// with a bounded run's worth of headroom on top for the non-dispatch work a
// queued run also does (the dynamic import of the heavy core, the completed-row
// re-verification, the message build). A guard equal to the dispatch deadline
// would race it at the same instant and could abandon a run whose dispatch was
// about to resolve with results; strictly greater means the bounded dispatch
// always wins and this guard only ever fires on non-dispatch work genuinely
// stuck.
//
// The derivation is ASSERTED, not merely written down: lib/__db_tests__/
// post-workout-duplicates.test.ts reds unless this is strictly greater than the
// shared deadline (and the shared deadline itself clears every channel cap with
// headroom). The 30s margin is provisional — chosen as generous against the
// non-dispatch legs, not measured.
export const POST_WORKOUT_DISPATCH_TIMEOUT_MS =
  NOTIFICATION_DISPATCH_TIMEOUT_MS + 30_000;

type DispatchRunner = (profileId: number, activityId: number) => Promise<void>;

// One pending timer per (profile, activity); re-arming replaces the timer.
const pending = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; run: () => Promise<void> }
>();

function key(profileId: number, activityId: number): string {
  return `${profileId}:${activityId}`;
}

// The tail of each profile's in-flight chain. Present only while that profile has a
// run queued or running; the entry is dropped when the chain drains, so this never
// grows with the number of profiles the instance has ever dispatched for.
const chains = new Map<number, Promise<void>>();

// Queue `task` behind everything already queued for this profile, and resolve when it
// has finished. The task never rejects — the caller wraps it, and the wrap's own
// logging is total (safeString, in `run` below) so the catch cannot itself throw —
// but the chain is joined with `then(t, t)` regardless so one broken link can never
// stall the rest.
function serializeForProfile(
  profileId: number,
  task: () => Promise<void>
): Promise<void> {
  const previous = chains.get(profileId) ?? Promise.resolve();
  const next = previous.then(task, task);
  chains.set(profileId, next);
  void next.then(() => {
    if (chains.get(profileId) === next) chains.delete(profileId);
  });
  return next;
}

// Give up waiting on `task` after `ms`, so a dispatch that never settles cannot hold
// the profile's chain (or the tick's exit drain) forever. The task itself keeps
// running — nothing here can cancel a send in flight — but it stops being anyone's
// blocker. Promise.race attaches a handler to `task`, so a late rejection is still
// handled and never surfaces as an unhandled rejection.
function withDispatchTimeout(task: Promise<void>, ms: number): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bound = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`post-workout dispatch exceeded ${ms}ms`)),
      ms
    );
    // Never hold the process open just to enforce a deadline.
    timer.unref?.();
  });
  return Promise.race([task, bound]).finally(() => clearTimeout(timer));
}

// Introspection for tests: profiles with a run queued or in flight.
export function serializedPostWorkoutProfiles(): number[] {
  return [...chains.keys()];
}

async function defaultRunner(
  profileId: number,
  activityId: number
): Promise<void> {
  const { runPostWorkoutForActivity } = await import("./workout-presence");
  await runPostWorkoutForActivity(profileId, activityId, {
    verifyCompletedToday: true,
  });
}

// Arm (or RE-arm — the coalescing contract) the delayed post-workout dispatch
// for one just-completed activity. Fire-and-forget: errors are logged, never
// thrown into the arming write path.
export function queuePostWorkoutDispatch(
  profileId: number,
  activityId: number,
  delayMs: number = POST_WORKOUT_DISPATCH_DELAY_MS,
  runner: DispatchRunner = defaultRunner
): void {
  // A frozen-clock instance (ALLOS_TEST_NOW — the e2e webServer) never arms the
  // wall-clock timer: a real-time delay is meaningless under a frozen "now", and
  // a background dispatch firing mid-suite would race the specs' channel-config
  // fixtures (the delivery-health marker is shared state). The unit/DB/action
  // tiers don't set the override, so the queue is fully exercised there; in a
  // frozen e2e app the tick backstop remains the (never-run) delivery path.
  if (runner === defaultRunner && clockOverride()) return;
  const k = key(profileId, activityId);
  const existing = pending.get(k);
  if (existing) clearTimeout(existing.timer);
  const run = () => {
    // Synchronous, before the chain is joined: the timer has fired, so this key is no
    // longer re-armable, and `pendingPostWorkoutDispatchKeys()` must say so at once
    // whether or not an earlier run for this profile is still in flight.
    pending.delete(k);
    // The serialization (#3021): two rows from ONE push arm two timers that expire in
    // the same tick, and the twin guard inside `runner` is read-then-act. Queued, the
    // second run reads a marker the first has already stamped and declines.
    return serializeForProfile(profileId, async () => {
      try {
        // Bounded (see the header): a run that never settles must not take the
        // next activity's dispatch — or the tick's exit drain — down with it.
        // The dispatch leg is already bounded inside dispatch() (#3057); this
        // strictly-greater guard covers the rest of the run.
        await withDispatchTimeout(
          runner(profileId, activityId),
          POST_WORKOUT_DISPATCH_TIMEOUT_MS
        );
      } catch (e) {
        // Best-effort: the tick backstop re-delivers on its next run (the one-shot
        // marker is stamped only on successful delivery, so nothing is lost).
        // safeString, not String: a rejection value with a null prototype makes
        // `String(e)` throw INSIDE this catch, which would reject the chain entry,
        // short-circuit the flush's Promise.all past every other profile, and
        // surface as an unhandled rejection. Nothing in production throws such a
        // value — but "the task never rejects" is the property the chain and the
        // drain are built on, so it is guaranteed here rather than assumed.
        log.error("delayed post-workout dispatch failed", {
          profile: profileId,
          activity: activityId,
          err: e instanceof Error ? e : safeString(e),
        });
      }
    });
  };
  const timer = setTimeout(() => void run(), delayMs);
  // Never hold the process open just for a pending nudge (the tick process
  // flushes explicitly; a long-lived web process runs it on schedule).
  timer.unref?.();
  pending.set(k, { timer, run });
}

// Run every pending dispatch NOW. The notify tick calls this before its
// process.exit so a dispatch armed during the tick (an integration sync landing
// a completed session) isn't dropped with the process.
export async function flushPostWorkoutDispatches(): Promise<void> {
  const entries = [...pending.values()];
  for (const e of entries) clearTimeout(e.timer);
  for (const e of entries) await e.run();
  // Each e.run() above resolves only when its own queued task has finished, so the
  // loop already drains what this flush armed. A run armed EARLIER (a web-process
  // timer that fired while the tick was working) can still be on a profile's chain,
  // and awaiting the chain tails picks those up too — the tick must not exit with a
  // half-delivered dispatch behind it.
  await Promise.all([...chains.values()]);
}

// Introspection for tests: the pending (profileId:activityId) keys.
export function pendingPostWorkoutDispatchKeys(): string[] {
  return [...pending.keys()];
}
