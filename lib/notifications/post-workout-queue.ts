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

import { createLogger } from "../log";
import { clockOverride } from "../clock";

const log = createLogger("notify");

export const POST_WORKOUT_DISPATCH_DELAY_MS = 60_000;

type DispatchRunner = (profileId: number, activityId: number) => Promise<void>;

// One pending timer per (profile, activity); re-arming replaces the timer.
const pending = new Map<
  string,
  { timer: ReturnType<typeof setTimeout>; run: () => Promise<void> }
>();

function key(profileId: number, activityId: number): string {
  return `${profileId}:${activityId}`;
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
  const run = async () => {
    pending.delete(k);
    try {
      await runner(profileId, activityId);
    } catch (e) {
      // Best-effort: the tick backstop re-delivers on its next run (the one-shot
      // marker is stamped only on successful delivery, so nothing is lost).
      log.error("delayed post-workout dispatch failed", {
        profile: profileId,
        activity: activityId,
        err: e instanceof Error ? e : String(e),
      });
    }
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
}

// Introspection for tests: the pending (profileId:activityId) keys.
export function pendingPostWorkoutDispatchKeys(): string[] {
  return [...pending.keys()];
}
