// "IS THIS STREAM EXPECTED TO BE ACTIVE?" — one pure predicate, no DB, no clock.
//
// Two features ask it, at two grains, about two streams, and #2146 said outright that
// they must not answer it twice:
//
//   • #2097's morning waiting window asks it about SLEEP, at multi-day grain: is last
//     night even coming, or has this person stopped wearing the tracker? The
//     connection-side signal structurally cannot see that — the phone keeps syncing
//     steps, so `ok=1` events keep landing and only the sleep rows stop.
//   • #2146's quiet-stream row asks it about HEART RATE, before reporting a same-day
//     intraday gap. Without it, a watch put away three weeks ago reports quiet every
//     single day forever, for exactly the same reason: nothing else can see it either.
//
// The shape both need is the same one: WAS this stream delivering recently? Not "is it
// delivering right now" — that is the question the caller is trying to answer, and
// asking it of the window would make the answer circular. So the window deliberately
// looks at the days BEHIND the one under examination.
//
// DECLARED, NOT LEARNED. `windowDays`/`minDays` come from a declaration — the #2097
// sleep constants below, or a registry stream's `expectedActive` facet — never from a
// fitted wear pattern (#2146 constraint 2). Two of three is the shipped shape: it
// tolerates one forgotten charge without flipping, and gives up after two or three
// consecutive misses.

import { shiftDateStr } from "./date";

/**
 * Did this stream deliver on at least `minDays` of the `windowDays` local days
 * immediately BEFORE `todayStr`?
 *
 * `recordedDays` is a set of profile-local `YYYY-MM-DD` day strings — whatever the
 * domain counts as "this stream delivered that day". The projection from stored
 * instants to local days belongs to the caller, because only the caller knows which
 * column carries the day (see lib/row-instants.ts `rowLocalDay`).
 *
 * `todayStr` itself is never inspected. A stream that has delivered nothing at all
 * today is precisely the case both callers exist for.
 */
export function isStreamActive(
  recordedDays: Iterable<string>,
  todayStr: string,
  windowDays: number,
  minDays: number
): boolean {
  const recorded = new Set(recordedDays);
  let found = 0;
  for (let back = 1; back <= windowDays; back++) {
    if (recorded.has(shiftDateStr(todayStr, -back))) found++;
  }
  return found >= minDays;
}
