// The INGEST-PATH half of the stream frontier (#2341). The state transition itself is
// pure and lives in lib/stream-frontier.ts; nothing here re-derives it.
//
// One call, at the end of a SUCCESSFUL ingest, for each continuous stream the provider
// declares: read the frontier, fold the observation in, persist it. A provider that
// declares no continuous stream (weather, the calendar feed, the Fitbit Takeout
// archive — the app's other `hr_minutes` writer) is exempt BY CONSTRUCTION: the loop
// below has nothing to iterate.
//
// ── Why the observation is its own transaction, and why that is the strong form ──
//
// The rule this must satisfy is that a frontier observation can never disagree with
// the rows it describes. "The same transaction as the stream upsert" cannot be that
// rule's implementation here, for two reasons that are properties of the ingest path
// rather than preferences:
//
//   1. There is no single upsert transaction. A push is written in bounded per-chunk
//      IMMEDIATE transactions (#1064), so a batch of heart-rate minutes commits across
//      N of them and the frontier is only settled after the last one.
//   2. THE PUSH THAT MATTERS MOST CARRIES NO ROWS AT ALL. A watch on a charger
//      produces nothing, so the exporter's next push upserts zero stream rows and
//      opens zero transactions for them. That push IS the signal, and a write that
//      piggybacked on the upsert would miss exactly the case this exists to detect.
//
// So the observation opens ONE immediate transaction that READS `MAX(stream.ts)` and
// WRITES the row derived from it — read and write atomic with respect to each other,
// which is the invariant that matters and is strictly stronger than sharing a
// transaction with one of several upserts. Every row the push wrote is already
// committed when it runs, and the single synchronous better-sqlite3 connection means
// nothing can slip a stream row in between.
//
// It runs only on the SUCCESS path. A push that threw mid-batch records no observation:
// "a successful sync landed without advancing the frontier" is the claim being stored,
// and a failed push is not one.

import { db, writeTx } from "./db";
import { instantNow } from "./clock";
import { INTEGRATIONS } from "./integrations/registry";
import { continuousStreamsFor } from "./integrations/continuous-streams";
import {
  latestStreamInstant,
  readStreamFrontier,
} from "./queries/continuous-streams";
import { observeFrontier, type StreamFrontierState } from "./stream-frontier";

/**
 * Record what this push did to every continuous stream the provider declares.
 *
 * Returns the folded state per stream id, so the caller — and the DB tier's tests —
 * can assert what was observed without re-reading. A provider that is unknown or
 * declares no stream observes nothing and returns an empty record.
 */
export function observeStreamFrontiers(
  profileId: number,
  provider: string,
  at: string = instantNow()
): Record<string, StreamFrontierState> {
  // The ingest path carries its source as a plain string (it is also the value written
  // into the rows' `source` column), so the registry is matched rather than indexed —
  // an unregistered source simply declares no stream and observes nothing.
  const streams = continuousStreamsFor(
    INTEGRATIONS.find((def) => def.id === provider)
  );
  if (streams.length === 0) return {};
  return writeTx(() => {
    const upsert = db.prepare(
      `INSERT INTO stream_frontiers
         (profile_id, provider, stream, frontier_at, advanced_at, observed_at,
          syncs_since_advance)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(profile_id, provider, stream) DO UPDATE SET
         frontier_at = excluded.frontier_at,
         advanced_at = excluded.advanced_at,
         observed_at = excluded.observed_at,
         syncs_since_advance = excluded.syncs_since_advance`
    );
    const observed: Record<string, StreamFrontierState> = {};
    for (const stream of streams) {
      // Read INSIDE the transaction: this value is what the stored frontier claims,
      // so the two must not be able to come from different moments.
      const frontier = latestStreamInstant(profileId, stream.table, provider);
      const next = observeFrontier(
        readStreamFrontier(profileId, provider, stream.id),
        frontier,
        at
      );
      upsert.run(
        profileId,
        provider,
        stream.id,
        next.frontierAt,
        next.advancedAt,
        next.observedAt,
        next.syncsSinceAdvance
      );
      observed[stream.id] = next;
    }
    return observed;
  });
}
