// Per-profile daily AI-operation cap (rate-limiting Fix 1). Bounds the per-profile
// cost of AI-backed document processing and insight/suggestion generation: a
// logged-in member could otherwise loop uploads (or hammer the generate button)
// and run up unbounded Claude API spend. The DB-backed counter (ai_usage_counters,
// see lib/db.ts) records how many Claude calls a profile dispatched today — in ITS
// OWN timezone-local day (today(profileId)) — split by kind. Call sites consult
// this BEFORE dispatching a request and, on exhaustion, degrade gracefully
// (store-but-skip an upload / offline fallback for insights) rather than erroring.
//
// The DECISION + limit logic is PURE and lives in lib/ai-usage-limits.ts (imports
// nothing, unit-tested in the pure suite); this module is the thin DB wrapper that
// does the read-then-increment in a single better-sqlite3 transaction (synchronous,
// so no interleave within the process) and is always scoped by profile_id. It
// re-exports the pure API so callers have one import surface (@/lib/ai-usage). The
// DB wrapper itself (atomic read-increment, per-kind and per-profile independence)
// is exercised by the DB-tier test lib/__db_tests__/ai-usage.test.ts.

import { db, today } from "./db";
import {
  decideAiUsage,
  decideAiRefund,
  type AiUsageKind,
  type AiUsageResult,
} from "./ai-usage-limits";

export {
  decideAiUsage,
  decideAiRefund,
  dailyLimitFor,
  extractionDailyLimit,
  insightDailyLimit,
  narrativeDailyLimit,
  DEFAULT_DAILY_EXTRACTION_LIMIT,
  DEFAULT_DAILY_INSIGHT_LIMIT,
  DEFAULT_DAILY_NARRATIVE_LIMIT,
} from "./ai-usage-limits";
export type {
  AiUsageKind,
  AiUsageResult,
  AiUsageDecision,
} from "./ai-usage-limits";

// DB wrapper: atomically read the profile's current count for (day, kind), apply
// the pure decision, and increment when allowed — all in ONE transaction so two
// concurrent calls can't both read the same count and both pass. Always scoped by
// profile_id (never reads or writes another profile's counter). `day` defaults to
// the profile's local date; callers pass it explicitly only in tests.
//
// Quota is consumed here, BEFORE the Claude call dispatches (so a check-then-act
// race can't let two concurrent calls both pass). A TRANSIENT extraction failure
// then refunds its unit via refundAiUsage below (issue #135, item 3) — the cap
// still counts every attempt while in flight, but a flaky evening of timeouts no
// longer permanently exhausts the day with nothing imported. A `skipped` outcome is
// NOT refunded (the model declined, or the cap already blocked the charge).
//
// Atomicity holds WITHIN a single Node process: better-sqlite3 is synchronous and
// every AI-writing path runs in the web process (the notify sidecar doesn't call
// these), so the read and the increment can't interleave. A second AI-writing
// process would break that assumption and require db.transaction(...).immediate plus
// an atomic `SET count = count + 1`.
export function checkAndIncrementAiUsage(
  profileId: number,
  kind: AiUsageKind,
  limit: number,
  day: string = today(profileId)
): AiUsageResult {
  const run = db.transaction((): AiUsageResult => {
    const row = db
      .prepare(
        "SELECT count FROM ai_usage_counters WHERE profile_id = ? AND day = ? AND kind = ?"
      )
      .get(profileId, day, kind) as { count: number } | undefined;
    const decision = decideAiUsage(row?.count ?? 0, limit);
    if (decision.allowed) {
      db.prepare(
        `INSERT INTO ai_usage_counters (profile_id, day, kind, count)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(profile_id, day, kind)
           DO UPDATE SET count = ?`
      ).run(profileId, day, kind, decision.nextCount, decision.nextCount);
    }
    return { allowed: decision.allowed, remaining: decision.remaining };
  });
  return run();
}

// Refund one unit for a (day, kind) counter after a TRANSIENT extraction failure
// (issue #135, item 3): atomically re-read and decrement, floored at 0, in one
// transaction. Scoped by profile_id, and a no-op when there's no row / a zero count
// (a refund can never go negative or resurrect a counter). Callers pass the SAME
// `day` the charge used so a refund lands on the day the unit was consumed; it
// defaults to the profile's local date (the common case — extraction settles within
// minutes of dispatch, on the same local day).
export function refundAiUsage(
  profileId: number,
  kind: AiUsageKind,
  day: string = today(profileId)
): void {
  const run = db.transaction((): void => {
    const row = db
      .prepare(
        "SELECT count FROM ai_usage_counters WHERE profile_id = ? AND day = ? AND kind = ?"
      )
      .get(profileId, day, kind) as { count: number } | undefined;
    if (row === undefined) return; // nothing was ever charged for this day/kind
    const nextCount = decideAiRefund(row.count);
    db.prepare(
      "UPDATE ai_usage_counters SET count = ? WHERE profile_id = ? AND day = ? AND kind = ?"
    ).run(nextCount, profileId, day, kind);
  });
  run();
}

// Read the profile's current count for a day/kind WITHOUT incrementing (for
// display/diagnostics). Scoped by profile_id.
export function getAiUsageCount(
  profileId: number,
  kind: AiUsageKind,
  day: string = today(profileId)
): number {
  const row = db
    .prepare(
      "SELECT count FROM ai_usage_counters WHERE profile_id = ? AND day = ? AND kind = ?"
    )
    .get(profileId, day, kind) as { count: number } | undefined;
  return row?.count ?? 0;
}
