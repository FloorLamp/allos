// The shared whole-dispatch deadline (#3057). dispatch() fans a message out to
// every configured channel under one Promise.all, so before this bound the
// slowest channel was the whole dispatch's latency — and a channel that never
// settles (a push endpoint that accepts the connection and answers nothing; an
// SMTP session with no explicit socket bounds) could consume an entire notify
// tick. Every channel keeps its own shorter transport cap
// (TELEGRAM_CALL_TIMEOUT_MS 30s, HOME_ASSISTANT_CALL_TIMEOUT_MS 10s,
// PUSH_SEND_TIMEOUT_MS 30s, the EMAIL_*_TIMEOUT_MS bounds in lib/email.ts — all
// asserted at or below this deadline in
// lib/__db_tests__/post-workout-duplicates.test.ts), so the deadline only ever
// fires on a transport whose cap turned out not to be a whole-response bound
// (a socket timeout fed a trickle of packets, a multi-recipient loop) — it is
// the final guard, never the working path.
//
// Composing this deadline's signal into each transport's own AbortSignal was
// considered and skipped: every local cap is strictly below the deadline, so a
// composed signal would always be won by the local one — the composition adds a
// plumbing surface and cancels nothing the caps don't already cancel.
//
// This lives in its own module — not index.ts — because the post-workout queue
// derives its whole-task guard from the constant, and post-workout-queue.ts is
// deliberately light (armed from Server Actions and sync runners; the heavy
// channel stack stays behind a dynamic import). index.ts re-exports the PUBLIC
// surface — NOTIFICATION_DISPATCH_TIMEOUT_MS, DispatchTimeoutError, and
// DispatchResult — so `from "@/lib/notifications"` serves those unchanged;
// settleWithinDeadline and DispatchAttempt stay here, dispatch()'s internal
// machinery rather than API.

import type { ChannelId } from "./types";

export const NOTIFICATION_DISPATCH_TIMEOUT_MS = 120_000;

// One channel's outcome in a dispatch fan-out. `timedOut` marks the one way a
// result can be synthesized rather than earned: the channel was still pending
// when the shared deadline fired. It is never success and never "nothing
// configured" — the slot marker/retry semantics read `ok` exactly as they do
// for an ordinary failure.
export interface DispatchResult {
  id: ChannelId;
  ok: boolean;
  error?: string;
  timedOut?: true;
}

// The typed timeout failure a still-pending channel is resolved with at the
// deadline, so a timeout is distinguishable from the transport's own errors.
export class DispatchTimeoutError extends Error {
  readonly channel: ChannelId;
  constructor(channel: ChannelId, deadlineMs: number) {
    super(
      `${channel} still pending at the ${deadlineMs}ms whole-dispatch deadline`
    );
    this.name = "DispatchTimeoutError";
    this.channel = channel;
  }
}

export interface DispatchAttempt {
  id: ChannelId;
  promise: Promise<DispatchResult>;
}

// Resolve every attempt's result, no later than `deadlineMs` after the call.
//
// Attempts that settled in time keep their ordinary results; one still pending
// at the deadline yields `ok: false` with a DispatchTimeoutError message and
// `timedOut` set. The underlying promise is then DETACHED safely: it keeps
// running (nothing here can cancel a send in flight), its late settlement is
// reported once through `onLateSettle` for logging, and nothing it does can
// reach the returned array — the results are frozen into a new array at the
// deadline, so a late completion cannot mutate what the caller already acted
// on, and every handler chain stays attached so a late rejection never
// surfaces as an unhandled rejection.
//
// The no-unhandled-rejection guarantee above rests on this helper guarding
// BOTH of its inputs, not on trusting either: dispatch() wraps every send in
// its own catch, so attempts should never reject — a rejection is nevertheless
// folded into an ordinary failure result here — and `onLateSettle` runs inside
// its own catch, so a throwing observer (unreachable today: lib/log.ts is
// total) is swallowed rather than surfacing from a promise chain nobody
// awaits.
export async function settleWithinDeadline(
  attempts: readonly DispatchAttempt[],
  deadlineMs: number,
  onLateSettle: (id: ChannelId, result: DispatchResult) => void
): Promise<DispatchResult[]> {
  const guarded = attempts.map((a) =>
    a.promise.then(
      (r) => r,
      (e): DispatchResult => ({
        id: a.id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      })
    )
  );
  const settled: (DispatchResult | undefined)[] = new Array(attempts.length);
  const allDone = Promise.all(
    guarded.map((p, i) =>
      p.then((r) => {
        settled[i] = r;
      })
    )
  ).then(() => "settled" as const);

  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<"deadline">((resolve) => {
    timer = setTimeout(() => resolve("deadline"), deadlineMs);
    // Never hold the process open just to enforce a deadline.
    timer.unref?.();
  });
  const winner = await Promise.race([allDone, deadline]);
  clearTimeout(timer);
  if (winner === "settled") {
    // Every slot was written before allDone resolved.
    return settled.map((r) => r!);
  }
  // The deadline fired. Freeze what has settled into a new array — late writes
  // into `settled` can no longer reach what the caller sees — and leave each
  // still-pending attempt observed for logging only.
  return attempts.map((a, i): DispatchResult => {
    const done = settled[i];
    if (done) return done;
    void guarded[i]
      .then((late) => onLateSettle(a.id, late))
      .catch(() => {
        // The observation is best-effort logging; a throwing observer has
        // nowhere further to report and must not become an unhandled
        // rejection (see the contract above).
      });
    return {
      id: a.id,
      ok: false,
      error: new DispatchTimeoutError(a.id, deadlineMs).message,
      timedOut: true,
    };
  });
}
