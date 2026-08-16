// The fasting GATHER layer (#2756/#2757): the reads the surfaces and the notification
// tick share, with the memo lifetimes each of them can actually justify.
//
// The store (lib/fast-store.ts) holds the SQL; the write core (lib/fast-write.ts) holds
// the transitions; this holds "what does a reader need to know", so a page, a Server
// Action and the hourly tick cannot each grow their own version of the same question.

import { cache } from "@/lib/request-cache";
import { tickCached } from "@/lib/tick-cache";
import { db } from "@/lib/db";
import type { Fast } from "@/lib/fasting";
import { getActiveFast, listFasts } from "@/lib/fast-store";
import { servingsDuringFast } from "@/lib/fasting";

// The profile's active fast, or null.
//
// MEMOIZED ON BOTH LIFETIMES. Within a REQUEST the same answer is wanted by the
// Nutrition chip, the food-log action's follow-up offer and the usual-routine offer
// gather; within a TICK it is wanted once per candidate food send per profile, and
// `cache()` is deliberately identity outside a Next request (lib/request-cache.ts), so
// the tick needs its own.
//
// THE TICK MEMO IS SAFE HERE, on the rule lib/tick-cache.ts states: find the writers
// first. The only writers of `fasts` are the lifecycle cores in lib/fast-write.ts,
// reached exclusively from Server Actions and (later) the Telegram webhook — i.e. the
// request paths and the sidecar's separate `poll` mode, never from `tick()`. Nothing
// inside a profile's tick starts, ends, discards or reopens a fast, so this memo cannot
// be seeded and then invalidated inside its own scope.
//
// AND THE DIRECTION OF A STALE READ IS THE SAFE ONE, which is the check #2674 asks for
// by name. A snapshot of a SUPPRESSION bus reads as "still silenced" and that is a
// safety direction; here the snapshot is of the fast itself, and the only send it can
// suppress is a food nudge (lib/fasting-standdown.ts's closed allowlist). The worst a
// stale value can do is stand a food nudge down for the rest of one tick, or send one
// the user would have been spared. Neither is a safety signal, by construction.
export const getActiveFastCached = cache(
  tickCached(
    "getActiveFast",
    (profileId: number) => String(profileId),
    (profileId: number): Fast | null => getActiveFast(profileId)
  )
);

/** A profile's fasts, newest-started first — the Nutrition history list. */
export const getFastHistory = cache((profileId: number, limit = 20): Fast[] =>
  listFasts(profileId, limit)
);

// How many servings with a STATED eating instant fall inside a fast's interval — the
// quiet "2 servings logged during" annotation a completed fast carries in history
// (#2756). BOTH FACTS STAND: this counts and says nothing else. It never adjudicates
// between the claim and the log, and it never edits either.
//
// Only `occurred_at` is consulted, never `recorded_at`: a tap instant is when somebody
// pressed a button, and inferring an eating time from it is the exact trap that makes
// fasting an explicit lifecycle in the first place. A serving with no stated eating time
// is therefore not counted — the annotation claims only what the ledger actually records.
export function getServingsDuringFast(profileId: number, fast: Fast): number {
  const rows = db
    .prepare(
      `SELECT occurred_at FROM food_log_events
        WHERE profile_id = ?
          AND occurred_at IS NOT NULL
          AND occurred_at >= ?
          AND (? IS NULL OR occurred_at < ?)`
    )
    .all(profileId, fast.started_at, fast.ended_at, fast.ended_at) as {
    occurred_at: string | null;
  }[];
  return servingsDuringFast(
    fast,
    rows.map((r) => r.occurred_at)
  );
}
