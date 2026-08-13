// THE COUNTER ARITHMETIC of a backfill job — "N items of M" — in one place (#2672).
//
// A backfill job has exactly one durable fact about its own history: `total_items`
// and `completed_items`. Everything else it knows is recomputed from the candidate
// query on demand (`runner.count`), because no per-candidate state is persisted —
// that refusal is deliberate and belongs to lib/integrations/backfill-outcome.ts.
//
// THE INVARIANT the three writes below all maintain:
//
//     total_items = carried + candidates
//
// where `carried` is the number of items this job has finished with such that they
// have LEFT the candidate query, and `candidates` is what the query returns now. The
// invariant holds across a run for free: every item the run backfills raises `carried`
// by one and lowers `candidates` by one.
//
// THE TRAP that #2672 fell into. `completed_items` is NOT `carried`. It also credits
// the items the source gave a final answer for — refused, gone, or answered with no
// payload — because a run that has given up on an item must not leave the bar stalled
// one short for the rest of its life (#2196). Those items are still in the candidate
// query, by design: no give-up marker is stored, so a ride made public again is picked
// up by the next retry. So on a re-queue, `completed_items + candidates` counts every
// one of them TWICE, and a job whose retryable item keeps failing grows its own
// denominator on every attempt — 2 candidates read "1 of 3", then "2 of 4", then
// "3 of 5", with the percentage moving backwards each time.
//
// THE RULE that replaces it: a resumed job credits exactly the items it will NOT ask
// the source about again. A backfilled item left the candidate query and is never
// re-asked, so it is carried. An unavailable one IS re-asked on the next run — that is
// what the missing give-up marker buys — so it is work again, and counting it as done
// while the run is about to spend two requests on it is the lie #2672 named.
//
// `carried` is therefore not free to read: it needs the split of `completed_items` that
// no column holds. What IS derivable is a bound. At most `candidates` of the completed
// items can still be in the query, so `carried >= completed_items - candidates`; and
// while the candidate set has not moved since the last write, the prior `total_items`
// IS `carried + candidates` exactly, which is what the floor below recovers. The two
// together reduce to `max(candidates, prior total)`, which is EXACT whenever the
// candidate set has not grown, and conservative — never inflated — when it has: new
// candidates hide under the floor until they exceed it, so the denominator can lag by
// at most `carried` while `total - completed` still names the real work left.
//
// #2385 — how this would learn it should stop:
//   WORKING: a job with a permanently-unavailable candidate and a retryable one holds
//     ONE denominator across any number of retries, and `total_items` still equals
//     `carried + runner.count()` after each one.
//   WRONG: `total_items` moves while the candidate set has not, in either direction;
//     `completed_items` exceeds `total_items`; a re-queue after a partly-successful
//     run forgets the items it already imported (#2195's "0 of 40").
//   DECEPTIVE SUCCESS: "the numbers stopped changing." A resume branch that simply
//     carried the prior row forward would also be perfectly stable — and would be
//     stably wrong the moment rides arrive or are deleted. The figure to read is
//     `total_items - completed_items` against `runner.count()`, which is the claim
//     the bar is actually making.

export interface BackfillCounterState {
  total_items: number;
  completed_items: number;
}

export interface BackfillCounters {
  total: number;
  completed: number;
}

// What a queue or re-queue writes. `prior` is the resumable job being continued
// (`paused` or `failed`) or null for a fresh batch — a `completed` job re-queued over
// a changed candidate set is a new batch and starts at 0 of N, so it passes null.
export function queuedBackfillCounters(
  prior: BackfillCounterState | null,
  candidates: number
): BackfillCounters {
  const total = Math.max(candidates, prior?.total_items ?? 0);
  return { total, completed: Math.max(total - candidates, 0) };
}

// What a run writes while it is going, and again when it ends. `remaining` is the
// runner's "still worth asking about" — the candidate count minus the items this run
// reached a final answer for — so the difference credits those alongside the ones
// actually imported, which is what keeps the bar moving through a stretch of
// unavailable items. `floor` holds an in-flight update from moving the bar backwards
// against a concurrent write; the end-of-run write passes none.
export function runningBackfillCompleted(
  total: number,
  remaining: number,
  floor = 0
): number {
  return Math.max(total - remaining, floor, 0);
}
